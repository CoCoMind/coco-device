/**
 * Synchronous Session Runner
 *
 * Full 6-activity session using the synchronous TTS + STT pipeline.
 * No Realtime API. No events. Just blocking calls.
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
import { buildPlan, Activity } from "./planner";
import { sendSessionSummary, createSessionIdentifiers, SessionSummaryPayload, SessionStatus } from "./backend";

// Audio config
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const SAMPLE_FORMAT = "S16_LE";
const OUTPUT_DEVICE = process.env.COCO_AUDIO_OUTPUT_DEVICE ?? "pulse";
const INPUT_DEVICE = process.env.COCO_AUDIO_INPUT_DEVICE ?? "pulse";
const AUDIO_DISABLED = process.env.COCO_AUDIO_DISABLE === "1";

// Recording config
const MAX_RECORD_SECONDS = 20;
const SILENCE_THRESHOLD = 500;
const SILENCE_DURATION_MS = 2500;

// Stop phrases
const STOP_PHRASES = [
  "stop session", "end session", "thank you", "thanks",
  "goodbye", "bye", "that's all", "i'm done"
];

const openai = new OpenAI();

interface SessionResult {
  utteranceCount: number;
  durationSec: number;
  transcripts: string[];
  stoppedEarly: boolean;
}

// Conversation history for LLM context
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
const conversationHistory: ChatMessage[] = [];

const SYSTEM_PROMPT = `You are Coco, a warm and supportive cognitive companion for older adults. You run 10-minute cognitive stimulation sessions.

Your personality:
- Warm, patient, and genuinely interested
- Use simple, clear language
- Acknowledge what the person shares with specific details
- Keep responses brief (1-2 sentences)
- Never be condescending

When acknowledging a response:
- Reference something specific they said
- Show genuine interest or appreciation
- Smoothly transition to the next activity

When closing a session:
- Summarize 1-2 highlights from what they shared
- End with warmth and encouragement`;

async function generateResponse(
  userMessage: string,
  activity: Activity,
  isClosing: boolean = false
): Promise<string> {
  log(`LLM: Generating response...`);
  const start = Date.now();

  // Add user message to history
  conversationHistory.push({ role: "user", content: userMessage });

  // Build context for this specific response
  let contextPrompt = "";
  if (isClosing) {
    contextPrompt = `The session is ending. Generate a personalized closing that:
1. References 1-2 specific things they shared during the session
2. Ends with warmth and encouragement
Keep it to 2-3 sentences.`;
  } else {
    contextPrompt = `Activity: ${activity.title || activity.category}
Goal: ${activity.goal || "Engage the participant"}
Instructions: ${activity.instructions || "Acknowledge their response warmly"}

Generate a brief (1-2 sentence) acknowledgment that:
1. References something specific from their response
2. Shows genuine interest
3. Transitions smoothly to continue`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: `[INSTRUCTION: ${contextPrompt}]` }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 150,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content?.trim() || "Thank you for sharing that.";
    log(`LLM: "${reply.slice(0, 60)}..." in ${Date.now() - start}ms`);

    // Add assistant response to history
    conversationHistory.push({ role: "assistant", content: reply });

    return reply;
  } catch (err) {
    log(`LLM: Error - ${err}`);
    return "Thank you for sharing that.";
  }
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function checkStopPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return STOP_PHRASES.some(phrase => lower.includes(phrase));
}

async function textToSpeech(text: string): Promise<Buffer> {
  log(`TTS: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);
  const start = Date.now();

  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
    response_format: "pcm",
  });

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
    const aplay = spawn("aplay", [
      "-t", "raw", "-f", SAMPLE_FORMAT, "-c", String(CHANNELS),
      "-r", String(SAMPLE_RATE), "-q", "-D", OUTPUT_DEVICE, "-",
    ], { stdio: ["pipe", "ignore", "inherit"] });

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

async function recordAudio(): Promise<Buffer> {
  if (AUDIO_DISABLED) {
    log(`Record: [DISABLED] Returning empty buffer`);
    return Buffer.alloc(0);
  }

  log(`Record: max=${MAX_RECORD_SECONDS}s, silence=${SILENCE_DURATION_MS}ms`);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let silenceStart: number | null = null;
    let hasHeardSpeech = false;

    const arecord = spawn("arecord", [
      "-t", "raw", "-f", SAMPLE_FORMAT, "-c", String(CHANNELS),
      "-r", String(SAMPLE_RATE), "-q", "-D", INPUT_DEVICE, "-",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    const maxTimer = setTimeout(() => {
      log(`Record: Max duration reached`);
      arecord.kill("SIGTERM");
    }, MAX_RECORD_SECONDS * 1000);

    arecord.on("error", (err) => {
      clearTimeout(maxTimer);
      reject(err);
    });

    arecord.on("exit", () => {
      clearTimeout(maxTimer);
      const fullBuffer = Buffer.concat(chunks);
      log(`Record: ${fullBuffer.length} bytes in ${Date.now() - start}ms`);
      resolve(fullBuffer);
    });

    arecord.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const rms = calculateRMS(chunk);
      const isSilent = rms < SILENCE_THRESHOLD;

      if (!isSilent) {
        hasHeardSpeech = true;
        silenceStart = null;
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

async function transcribe(audioBuffer: Buffer): Promise<string> {
  if (audioBuffer.length < 4800) {
    return "";
  }

  log(`STT: ${audioBuffer.length} bytes`);
  const start = Date.now();

  const wavBuffer = createWavBuffer(audioBuffer);
  const file = await toFile(wavBuffer, "audio.wav", { type: "audio/wav" });

  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: file,
    language: "en",
  });

  log(`STT: "${response.text}" in ${Date.now() - start}ms`);
  return response.text;
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

function getActivityPrompt(activity: Activity): string {
  // Use first script line if available, otherwise use prompt
  if (activity.script && activity.script.length > 0) {
    return activity.script[0];
  }
  return activity.prompt ?? `Let's do a ${activity.category} activity.`;
}

async function speak(text: string): Promise<void> {
  const audio = await textToSpeech(text);
  await playAudio(audio);
}

async function listenAndTranscribe(): Promise<string> {
  const audio = await recordAudio();
  return transcribe(audio);
}

async function runSession(): Promise<SessionResult> {
  const sessionStart = Date.now();
  const startedAt = new Date().toISOString();
  const transcripts: string[] = [];
  let stoppedEarly = false;

  // Generate session identifiers
  const { sessionId, planId } = createSessionIdentifiers();

  log("\n========================================");
  log("  COCO SESSION START (Sync Pipeline)");
  log(`  Session: ${sessionId.slice(0, 8)}...`);
  log("========================================\n");

  // Clear conversation history for new session
  conversationHistory.length = 0;

  // Build activity plan
  const plan = buildPlan();
  log(`Plan: ${plan.map(a => a.category).join(" → ")}`);

  // Intro
  const introMessage = "Hello! I'm Coco, your cognitive companion. I'm happy to spend some time with you today. Let's get started.";
  conversationHistory.push({ role: "assistant", content: introMessage });
  await speak(introMessage);

  // Run each activity
  for (let i = 0; i < plan.length; i++) {
    const activity = plan[i];
    const isLastActivity = i === plan.length - 1;
    log(`\n--- Activity ${i + 1}/${plan.length}: ${activity.category} (${activity.id}) ---`);

    const prompt = getActivityPrompt(activity);
    conversationHistory.push({ role: "assistant", content: prompt });
    await speak(prompt);

    const transcript = await listenAndTranscribe();

    if (transcript) {
      transcripts.push(transcript);
      log(`User: "${transcript}"`);

      // Check for stop phrase
      if (checkStopPhrase(transcript)) {
        log(`Stop phrase detected!`);
        stoppedEarly = true;
        break;
      }

      // Generate contextual acknowledgment (skip for last activity - we'll do personalized closing)
      if (!isLastActivity) {
        const ack = await generateResponse(transcript, activity, false);
        await speak(ack);
      } else {
        // For last activity, just add to history for closing
        conversationHistory.push({ role: "user", content: transcript });
      }
    } else {
      log(`No response captured`);
      const noResponseMsg = "I didn't catch that, but let's keep going.";
      conversationHistory.push({ role: "assistant", content: noResponseMsg });
      if (!isLastActivity) {
        await speak(noResponseMsg);
      }
    }
  }

  // Personalized closing
  if (!stoppedEarly && transcripts.length > 0) {
    // Generate personalized closing based on session
    const closingActivity = plan[plan.length - 1];
    const personalizedClosing = await generateResponse("", closingActivity, true);
    await speak(personalizedClosing);
  } else if (stoppedEarly) {
    await speak("It was lovely chatting with you. Take care!");
  } else {
    await speak("Thank you for spending this time with me. Take care, and I'll see you next time!");
  }

  const durationSec = Math.round((Date.now() - sessionStart) / 1000);
  const endedAt = new Date().toISOString();

  // Determine session status
  let status: SessionStatus = "success";
  if (transcripts.length === 0) {
    status = "unattended";
  } else if (stoppedEarly) {
    status = "early_exit";
  }

  log("\n========================================");
  log("  SESSION COMPLETE");
  log("========================================");
  log(`Duration: ${durationSec}s`);
  log(`Utterances: ${transcripts.length}`);
  log(`Status: ${status}`);
  log("========================================\n");

  // Backend sending disabled for now
  // TODO: Re-enable when backend fields are updated
  log("Backend summary disabled (skipping)");

  return {
    utteranceCount: transcripts.length,
    durationSec,
    transcripts,
    stoppedEarly,
  };
}

async function main() {
  try {
    const result = await runSession();

    console.log("\nSession Result:");
    console.log(JSON.stringify(result, null, 2));

    // Exit code based on result
    if (result.utteranceCount === 0) {
      process.exit(2); // Unattended
    }
    process.exit(0);
  } catch (err) {
    console.error("Session error:", err);
    process.exit(1);
  }
}

main();
