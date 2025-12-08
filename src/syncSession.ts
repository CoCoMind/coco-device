/**
 * Synchronous Session Runner
 *
 * Full cognitive training session using the synchronous TTS + STT pipeline.
 * Supports research-backed cognitive exercises with built-in scoring.
 *
 * Usage:
 *   npx dotenv -- npx tsx src/syncSession.ts
 */

// Polyfill File for Node 18 (required by OpenAI SDK)
import { File as NodeFile } from "node:buffer";
if (typeof globalThis.File === "undefined") {
  (globalThis as any).File = NodeFile;
}

import OpenAI, { toFile } from "openai";
import { spawn } from "node:child_process";
import { buildAdaptivePlan, buildPlan } from "./planner";
import { Activity, ActivityResult, SessionResult, CognitiveDomain } from "./types/activity";
import { runActivity, ExerciseContext } from "./exercises";
import {
  sendSessionSummary,
  createSessionIdentifiers,
  toActivityResultPayload,
  type SessionSummaryPayload,
  type SessionStatus,
} from "./backend";
import {
  loadOrCreateProfile,
  saveProfile,
  updateProfileWithResults,
} from "./utils/profileStore";
import { withRetry, API_TIMEOUT_MS } from "./retry";

// Audio config
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const SAMPLE_FORMAT = "S16_LE";
const OUTPUT_DEVICE = process.env.COCO_AUDIO_OUTPUT_DEVICE ?? "pulse";
const INPUT_DEVICE = process.env.COCO_AUDIO_INPUT_DEVICE ?? "pulse";
const AUDIO_DISABLED = process.env.COCO_AUDIO_DISABLE === "1";

// Recording config
const INITIAL_RECORD_SECONDS = 30;
const MAX_RECORD_SECONDS = 60;
const EXTEND_IF_SPEAKING_WITHIN_MS = 3000;
const SILENCE_THRESHOLD = 500;
const SILENCE_DURATION_MS = 2500;
const MIN_SPEECH_RMS = 300;

// Whisper hallucination phrases
const HALLUCINATION_PHRASES = [
  "thanks for watching",
  "thank you for watching",
  "subscribe",
  "like and subscribe",
  "silence",
  "sous-titres",
  "subtitles",
  "amara.org",
  "electric unicorn",
  "please subscribe",
  "see you next time",
  "bye bye",
  "the end",
  "music",
  "applause",
];

// Stop phrases
const STOP_PHRASES = [
  "stop session",
  "end session",
  "goodbye",
  "bye",
  "that's all",
  "i'm done",
  "i want to stop",
];

const MAX_LISTEN_RETRIES = 2;
const MAX_TURNS_PER_ACTIVITY = 3;

const openai = new OpenAI({ timeout: API_TIMEOUT_MS });

// Conversation history for LLM context
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
const conversationHistory: ChatMessage[] = [];

// Session state for word list delayed recall
let sessionState: { plantedWords?: string[] } = {};

const SYSTEM_PROMPT = `You are Coco, a warm and supportive cognitive companion for older adults. You run 15-minute cognitive stimulation sessions.

Your personality:
- Warm, patient, and genuinely interested
- Use simple, clear language
- Keep responses brief (1-2 sentences)
- Never be condescending

Your job is to gently guide conversation and cognitive exercises, drawing out memories and stories from the participant.`;

interface LLMResponse {
  text: string;
  shouldFollowUp: boolean;
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function checkStopPhrase(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return STOP_PHRASES.some((phrase) => {
    if (lower === phrase) return true;
    const regex = new RegExp(`\\b${phrase}\\b`, "i");
    const match = regex.test(lower);
    if (match && phrase.length <= 4) {
      const standaloneRegex = new RegExp(
        `^${phrase}[.!]?$|^${phrase}\\s+(now|for now|coco|there)`,
        "i"
      );
      return standaloneRegex.test(lower);
    }
    return match;
  });
}

async function textToSpeech(text: string): Promise<Buffer> {
  log(`TTS: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);
  const start = Date.now();

  const response = await withRetry(
    () => openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: text,
      response_format: "pcm",
    }),
    "TTS",
    { logger: log }
  );

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  log(`TTS: ${buffer.length} bytes in ${Date.now() - start}ms`);
  return buffer;
}

async function playAudio(audioBuffer: Buffer): Promise<void> {
  if (AUDIO_DISABLED) {
    log(`Play: [DISABLED] Would play ${audioBuffer.length} bytes`);
    return;
  }

  log(`Play: ${audioBuffer.length} bytes`);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const aplay = spawn(
      "aplay",
      [
        "-t", "raw", "-f", SAMPLE_FORMAT, "-c", String(CHANNELS),
        "-r", String(SAMPLE_RATE), "-q", "-D", OUTPUT_DEVICE, "-",
      ],
      { stdio: ["pipe", "ignore", "inherit"] }
    );

    aplay.on("error", reject);
    aplay.on("exit", (code) => {
      if (code === 0) {
        log(`Play: Done in ${Date.now() - start}ms`);
        resolve();
      } else {
        reject(new Error(`aplay exited with code ${code}`));
      }
    });

    aplay.stdin.write(audioBuffer);
    aplay.stdin.end();
  });
}

function calculateRMS(buffer: Buffer): number {
  let sum = 0;
  const samples = buffer.length / 2;
  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

interface RecordingResult {
  buffer: Buffer;
  hasHeardSpeech: boolean;
  peakRMS: number;
  firstSpeechTime?: number;
  duration_ms: number;
}

async function recordAudio(maxSeconds = INITIAL_RECORD_SECONDS): Promise<RecordingResult> {
  if (AUDIO_DISABLED) {
    log(`Record: [DISABLED] Returning empty buffer`);
    return { buffer: Buffer.alloc(0), hasHeardSpeech: false, peakRMS: 0, duration_ms: 0 };
  }

  log(`Record: initial=${maxSeconds}s, max=${MAX_RECORD_SECONDS}s`);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let silenceStart: number | null = null;
    let hasHeardSpeech = false;
    let peakRMS = 0;
    let lastSpeechTime = 0;
    let firstSpeechTime: number | undefined;
    let currentMaxMs = maxSeconds * 1000;
    let extended = false;

    const arecord = spawn(
      "arecord",
      [
        "-t", "raw", "-f", SAMPLE_FORMAT, "-c", String(CHANNELS),
        "-r", String(SAMPLE_RATE), "-q", "-D", INPUT_DEVICE, "-",
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    const checkTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= currentMaxMs) {
        const timeSinceLastSpeech = Date.now() - lastSpeechTime;
        if (
          !extended &&
          timeSinceLastSpeech < EXTEND_IF_SPEAKING_WITHIN_MS &&
          elapsed < MAX_RECORD_SECONDS * 1000
        ) {
          extended = true;
          currentMaxMs = MAX_RECORD_SECONDS * 1000;
          log(`Record: Extended to ${MAX_RECORD_SECONDS}s`);
        } else {
          log(`Record: Max duration reached`);
          arecord.kill("SIGTERM");
        }
      }
    }, 500);

    const absoluteMaxTimer = setTimeout(() => {
      log(`Record: Absolute max reached`);
      arecord.kill("SIGTERM");
    }, MAX_RECORD_SECONDS * 1000);

    arecord.on("error", (err) => {
      clearInterval(checkTimer);
      clearTimeout(absoluteMaxTimer);
      reject(err);
    });

    arecord.on("exit", () => {
      clearInterval(checkTimer);
      clearTimeout(absoluteMaxTimer);
      const fullBuffer = Buffer.concat(chunks);
      const duration_ms = Date.now() - start;
      log(`Record: ${fullBuffer.length} bytes, peakRMS=${Math.round(peakRMS)}, speech=${hasHeardSpeech} in ${duration_ms}ms`);
      resolve({ buffer: fullBuffer, hasHeardSpeech, peakRMS, firstSpeechTime, duration_ms });
    });

    arecord.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const rms = calculateRMS(chunk);
      peakRMS = Math.max(peakRMS, rms);
      const isSilent = rms < SILENCE_THRESHOLD;

      if (!isSilent) {
        if (!hasHeardSpeech) {
          firstSpeechTime = Date.now();
        }
        hasHeardSpeech = true;
        silenceStart = null;
        lastSpeechTime = Date.now();
      } else if (hasHeardSpeech) {
        if (silenceStart === null) {
          silenceStart = Date.now();
        } else if (Date.now() - silenceStart > SILENCE_DURATION_MS) {
          log(`Record: Silence detected`);
          arecord.kill("SIGTERM");
        }
      }
    });
  });
}

async function recordBrief(timeoutMs = 2000): Promise<RecordingResult> {
  if (AUDIO_DISABLED) {
    return { buffer: Buffer.alloc(0), hasHeardSpeech: false, peakRMS: 0, duration_ms: 0 };
  }

  const start = Date.now();

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let hasHeardSpeech = false;
    let peakRMS = 0;
    let firstSpeechTime: number | undefined;

    const arecord = spawn(
      "arecord",
      [
        "-t", "raw", "-f", SAMPLE_FORMAT, "-c", String(CHANNELS),
        "-r", String(SAMPLE_RATE), "-q", "-D", INPUT_DEVICE, "-",
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    const timer = setTimeout(() => {
      arecord.kill("SIGTERM");
    }, timeoutMs);

    arecord.on("exit", () => {
      clearTimeout(timer);
      const fullBuffer = Buffer.concat(chunks);
      resolve({
        buffer: fullBuffer,
        hasHeardSpeech,
        peakRMS,
        firstSpeechTime,
        duration_ms: Date.now() - start,
      });
    });

    arecord.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const rms = calculateRMS(chunk);
      peakRMS = Math.max(peakRMS, rms);
      if (rms >= SILENCE_THRESHOLD) {
        if (!hasHeardSpeech) firstSpeechTime = Date.now();
        hasHeardSpeech = true;
      }
    });
  });
}

function isHallucination(text: string): boolean {
  const lower = text.toLowerCase().trim();
  for (const phrase of HALLUCINATION_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  if (lower.length < 3) return true;
  return false;
}

async function transcribe(recording: RecordingResult): Promise<string> {
  const { buffer: audioBuffer, hasHeardSpeech, peakRMS } = recording;

  if (!hasHeardSpeech) {
    log(`STT: Skipped - no speech detected`);
    return "";
  }

  if (peakRMS < MIN_SPEECH_RMS) {
    log(`STT: Skipped - audio too quiet (peakRMS=${Math.round(peakRMS)})`);
    return "";
  }

  if (audioBuffer.length < 4800) {
    log(`STT: Skipped - buffer too small`);
    return "";
  }

  log(`STT: ${audioBuffer.length} bytes`);
  const start = Date.now();

  const wavBuffer = createWavBuffer(audioBuffer);
  const file = await toFile(wavBuffer, "audio.wav", { type: "audio/wav" });

  const response = await withRetry(
    () => openai.audio.transcriptions.create({
      model: "whisper-1",
      file: file,
      language: "en",
    }),
    "STT",
    { logger: log }
  );

  const text = response.text.trim();

  if (isHallucination(text)) {
    log(`STT: Filtered hallucination "${text}"`);
    return "";
  }

  log(`STT: "${text}" in ${Date.now() - start}ms`);
  return text;
}

function createWavBuffer(pcmBuffer: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcmBuffer.length;
  const fileSize = dataSize + 36;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function speak(text: string): Promise<void> {
  const audio = await textToSpeech(text);
  await playAudio(audio);
}

async function listen(): Promise<{ transcript: string; latency_ms: number }> {
  const promptEndTime = Date.now();
  const recording = await recordAudio();
  const transcript = await transcribe(recording);
  const latency_ms = recording.firstSpeechTime
    ? recording.firstSpeechTime - promptEndTime
    : recording.duration_ms;
  return { transcript, latency_ms };
}

async function listenBrief(
  timeoutMs = 2000
): Promise<{ transcript: string; latency_ms: number; hasResponse: boolean }> {
  const promptEndTime = Date.now();
  const recording = await recordBrief(timeoutMs);
  const transcript = await transcribe(recording);
  const latency_ms = recording.firstSpeechTime
    ? recording.firstSpeechTime - promptEndTime
    : recording.duration_ms;
  return { transcript, latency_ms, hasResponse: recording.hasHeardSpeech };
}

async function listenForDuration(
  seconds: number,
  encourageCallback?: () => Promise<void>
): Promise<{ transcript: string; latency_ms: number }> {
  const promptEndTime = Date.now();
  const recording = await recordAudio(seconds);

  // Call encourage callback mid-way if provided
  if (encourageCallback && seconds > 20) {
    // Already recorded, just for future enhancement
  }

  const transcript = await transcribe(recording);
  const latency_ms = recording.firstSpeechTime
    ? recording.firstSpeechTime - promptEndTime
    : recording.duration_ms;
  return { transcript, latency_ms };
}

async function generateResponse(
  userMessage: string,
  activity: Activity,
  turnNumber: number,
  isClosing: boolean = false
): Promise<LLMResponse> {
  log(`LLM: Generating response (turn ${turnNumber})...`);
  const start = Date.now();

  if (userMessage) {
    conversationHistory.push({ role: "user", content: userMessage });
  }

  let contextPrompt = "";
  if (isClosing) {
    contextPrompt = `The session is ending. Generate a personalized closing that:
1. References 1-2 specific things they shared during the session
2. Ends with warmth and encouragement
Keep it to 2-3 sentences.

Respond with JSON: {"text": "your closing message", "followUp": false}`;
  } else {
    const scriptPrompts = activity.script || [];
    const nextScriptPrompt = scriptPrompts[turnNumber] || null;

    contextPrompt = `Activity: ${activity.title || activity.cognitive_domain}
Goal: ${activity.goal || "Engage the participant"}
Instructions: ${activity.instructions || "Draw out their story"}
${nextScriptPrompt ? `Suggested follow-up: "${nextScriptPrompt}"` : ""}

The participant just said: "${userMessage}"

Decide whether to follow up or move on:

MOVE ON (followUp=false) if:
- They gave a negative/dismissive response
- They've shared something meaningful
- They seem disengaged
- This is turn ${turnNumber + 1} of ${MAX_TURNS_PER_ACTIVITY}

FOLLOW UP (followUp=true) ONLY if:
- Their response is brief but positive
- There's opportunity to draw out more

${turnNumber >= MAX_TURNS_PER_ACTIVITY - 1 ? "This is the LAST turn - set followUp=false." : ""}

Respond with JSON: {"text": "your response", "followUp": true/false}`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: contextPrompt },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 200,
      temperature: 0.7,
    });

    const rawReply =
      response.choices[0]?.message?.content?.trim() ||
      '{"text": "Thank you for sharing that.", "followUp": false}';

    let parsed: { text: string; followUp: boolean };
    try {
      const jsonStr = rawReply.replace(/```json\n?|\n?```/g, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      log(`LLM: Failed to parse JSON, using raw response`);
      parsed = { text: rawReply, followUp: false };
    }

    if (turnNumber >= MAX_TURNS_PER_ACTIVITY - 1 && parsed.followUp) {
      parsed.followUp = false;
    }

    log(`LLM: "${parsed.text.slice(0, 50)}..." followUp=${parsed.followUp} in ${Date.now() - start}ms`);
    conversationHistory.push({ role: "assistant", content: parsed.text });

    return { text: parsed.text, shouldFollowUp: parsed.followUp };
  } catch (err) {
    log(`LLM: Error - ${err}`);
    return { text: "Thank you for sharing that.", shouldFollowUp: false };
  }
}

/**
 * Create exercise context for the activity handlers
 */
function createExerciseContext(): ExerciseContext {
  return {
    speak,
    listen,
    listenBrief,
    listenForDuration,
    generateResponse: async (userMessage, activity, turnNumber) => {
      const resp = await generateResponse(userMessage, activity, turnNumber);
      return resp;
    },
    log,
    getSessionState: () => sessionState,
    setSessionState: (state) => {
      sessionState = { ...sessionState, ...state };
    },
  };
}

async function runSession(): Promise<SessionResult> {
  const sessionStart = Date.now();
  const startedAt = new Date().toISOString();
  const activityResults: ActivityResult[] = [];
  let stoppedEarly = false;
  let totalUtterances = 0;

  // Device and participant identifiers
  const deviceId = process.env.COCO_DEVICE_ID ?? process.env.HOSTNAME ?? "unknown-device";
  const participantId = process.env.COCO_PARTICIPANT_ID;
  const userExternalId = process.env.COCO_USER_EXTERNAL_ID ?? participantId;

  // Generate session identifiers
  const { sessionId, planId } = createSessionIdentifiers();

  log("\n========================================");
  log("  COCO SESSION START (Cognitive Training)");
  log(`  Session: ${sessionId.slice(0, 8)}...`);
  log("========================================\n");

  // Clear state for new session
  conversationHistory.length = 0;
  sessionState = {};

  // Build adaptive plan
  const plan = buildAdaptivePlan();
  log(`Plan: ${plan.activities.map((a) => a.id).join(" → ")}`);

  // Create exercise context
  const ctx = createExerciseContext();

  // Intro
  const introMessage =
    "Hello! I'm Coco, your cognitive companion. I have some fun activities planned for us today.";
  conversationHistory.push({ role: "assistant", content: introMessage });
  await speak(introMessage);

  // Readiness check
  const readinessPrompt = "Are you ready to begin?";
  conversationHistory.push({ role: "assistant", content: readinessPrompt });
  await speak(readinessPrompt);

  let isReady = false;
  let readinessAttempts = 0;
  const MAX_READINESS_ATTEMPTS = 3;

  while (!isReady && readinessAttempts < MAX_READINESS_ATTEMPTS) {
    readinessAttempts++;
    const response = await listen();

    if (response.transcript) {
      log(`Readiness response: "${response.transcript}"`);
      if (checkStopPhrase(response.transcript)) {
        await speak("No problem. Take care, and I'll be here when you're ready!");
        const durationSec = Math.round((Date.now() - sessionStart) / 1000);
        return {
          session_id: sessionId,
          plan_id: planId,
          activity_results: [],
          domain_scores: {},
          duration_sec: durationSec,
          utterance_count: 0,
          status: "early_exit",
          started_at: startedAt,
          ended_at: new Date().toISOString(),
        };
      }
      isReady = true;
      totalUtterances++;
      await speak("Great! Let's get started.");
    } else {
      if (readinessAttempts < MAX_READINESS_ATTEMPTS) {
        const retryPrompts = [
          "I'm here when you're ready. Just say hello to begin.",
          "Take your time. Let me know when you'd like to start.",
        ];
        await speak(retryPrompts[readinessAttempts - 1] || retryPrompts[1]);
      }
    }
  }

  if (!isReady) {
    await speak("I'll be here when you're ready. Take care!");
    const durationSec = Math.round((Date.now() - sessionStart) / 1000);

    // Send unattended summary
    const payload: SessionSummaryPayload = {
      session_id: sessionId,
      plan_id: planId,
      user_external_id: userExternalId,
      participant_id: participantId,
      device_id: deviceId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      duration_seconds: durationSec,
      turn_count: 0,
      status: "unattended",
      sentiment_summary: "neutral",
      sentiment_score: 0.5,
    };
    await sendSessionSummary(payload);

    return {
      session_id: sessionId,
      plan_id: planId,
      activity_results: [],
      domain_scores: {},
      duration_sec: durationSec,
      utterance_count: 0,
      status: "unattended",
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    };
  }

  // Run each activity
  for (let i = 0; i < plan.activities.length; i++) {
    const activity = plan.activities[i];
    log(`\n--- Activity ${i + 1}/${plan.activities.length}: ${activity.title} (${activity.id}) ---`);

    try {
      // Run the activity through the appropriate handler
      const result = await runActivity(activity, ctx);
      activityResults.push(result);
      totalUtterances += result.turn_count;

      // Check for stop phrase in any transcript
      for (const transcript of result.transcripts) {
        if (checkStopPhrase(transcript)) {
          stoppedEarly = true;
          break;
        }
      }

      if (stoppedEarly) break;
    } catch (err) {
      log(`Activity error: ${err}`);
      // Continue with next activity
    }
  }

  // Personalized closing if not already done
  if (!stoppedEarly && activityResults.length > 0) {
    await speak("Thank you for spending this time with me. You did wonderful work today!");
  } else if (stoppedEarly) {
    await speak("It was lovely chatting with you. Take care!");
  }

  const durationSec = Math.round((Date.now() - sessionStart) / 1000);
  const endedAt = new Date().toISOString();

  // Compute domain scores from activity results
  const domainScores: Record<CognitiveDomain, number> = {} as Record<CognitiveDomain, number>;
  for (const result of activityResults) {
    const domain = result.cognitive_domain;
    if (!domainScores[domain]) {
      domainScores[domain] = result.score;
    } else {
      // Average scores for same domain
      domainScores[domain] = Math.round((domainScores[domain] + result.score) / 2);
    }
  }

  // Calculate processing speed average
  const latencies = activityResults
    .filter((r) => r.response_time_ms)
    .map((r) => r.response_time_ms!);
  const processingSpeedAvg =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : undefined;

  // Determine status
  let status: "success" | "unattended" | "early_exit" | "error" = "success";
  if (totalUtterances === 0) {
    status = "unattended";
  } else if (stoppedEarly) {
    status = "early_exit";
  }

  log("\n========================================");
  log("  SESSION COMPLETE");
  log("========================================");
  log(`Duration: ${durationSec}s`);
  log(`Utterances: ${totalUtterances}`);
  log(`Activities: ${activityResults.length}`);
  log(`Status: ${status}`);
  log("========================================\n");

  // Send session summary with activity results
  const payload: SessionSummaryPayload = {
    session_id: sessionId,
    plan_id: planId,
    user_external_id: userExternalId,
    participant_id: participantId,
    device_id: deviceId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSec,
    turn_count: totalUtterances,
    status,
    sentiment_summary: status === "unattended" ? "neutral" : "positive",
    sentiment_score: status === "unattended" ? 0.5 : 0.75,
    // Include cognitive training results
    activity_results: activityResults.map(toActivityResultPayload),
    domain_scores: Object.entries(domainScores).map(([domain, score]) => ({
      domain: domain as CognitiveDomain,
      score,
    })),
    processing_speed_avg_ms: processingSpeedAvg,
  };

  await sendSessionSummary(payload);

  // Update local profile with session results
  if (userExternalId && activityResults.length > 0 && status === "success") {
    try {
      const profile = loadOrCreateProfile(userExternalId, participantId || "1");
      const updatedProfile = updateProfileWithResults(profile, activityResults);
      saveProfile(updatedProfile);
      log(`Profile updated: ${userExternalId}`);
    } catch (err) {
      log(`Failed to update profile: ${err}`);
    }
  }

  return {
    session_id: sessionId,
    plan_id: planId,
    activity_results: activityResults,
    domain_scores: domainScores,
    processing_speed_avg_ms: processingSpeedAvg,
    duration_sec: durationSec,
    utterance_count: totalUtterances,
    status,
    started_at: startedAt,
    ended_at: endedAt,
  };
}

async function main() {
  try {
    const result = await runSession();

    console.log("\nSession Result:");
    console.log(JSON.stringify(result, null, 2));

    // Exit code based on result
    if (result.utterance_count === 0) {
      process.exit(2); // Unattended
    }
    process.exit(0);
  } catch (err) {
    console.error("Session error:", err);
    process.exit(1);
  }
}

main();
