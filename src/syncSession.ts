/**
 * Speculative Streaming Session Runner
 *
 * Full 6-activity session using Deepgram streaming STT with speculative LLM/TTS.
 * Reduces turn latency from 6-40s to ~2-3s by overlapping operations.
 *
 * Usage:
 *   npx dotenv -- npx tsx src/syncSession.ts
 */

import OpenAI from "openai";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { spawn, ChildProcess } from "node:child_process";
import { buildPlan, Activity } from "./planner";
import { sendSessionSummary, sendSessionStartFailed, createSessionIdentifiers, type SessionSummaryPayload, type SessionStatus } from "./backend";
import { withRetry, API_TIMEOUT_MS, rateLimitEvents } from "./retry";
import { saveRecording, processUploadQueue, cleanupOldRecordings, closeAudioDb } from "./audioStorage";

// Audio config
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const SAMPLE_FORMAT = "S16_LE";
const OUTPUT_DEVICE = process.env.COCO_AUDIO_OUTPUT_DEVICE ?? "pulse";
const INPUT_DEVICE = process.env.COCO_AUDIO_INPUT_DEVICE ?? "pulse";
const AUDIO_DISABLED = process.env.COCO_AUDIO_DISABLE === "1";

// Recording config
const INITIAL_RECORD_SECONDS = 30; // Initial recording cap
const MAX_RECORD_SECONDS = 60;     // Absolute max (extended if still speaking)
const EXTEND_IF_SPEAKING_WITHIN_MS = 3000; // Extend if spoke in last 3 seconds
const SILENCE_THRESHOLD = 500;
const SILENCE_DURATION_MS = 2500;

// Minimum RMS for audio to be considered speech (filters out pure silence)
const MIN_SPEECH_RMS = 300;

// Stop phrases (intentional exit only - not casual thanks)
const STOP_PHRASES = [
  "stop session", "end session", "goodbye", "bye",
  "that's all", "i'm done", "i want to stop"
];

// Retry config for seniors
const MAX_LISTEN_RETRIES = 2; // Retry 2 times if not heard (3 attempts total)

// Streaming STT config
const UTTERANCE_END_MS = 2000; // 2s silence = user done speaking

const openai = new OpenAI({ timeout: API_TIMEOUT_MS });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

// Result from streaming listen with speculative LLM
interface StreamingResult {
  transcript: string;
  speculativeLLM: Promise<LLMResponse> | null;
  stoppedEarly: boolean;
  audioBuffer: Buffer;
  durationMs: number;
}

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
- Keep responses brief (1-2 sentences)
- Never be condescending

Engagement principles:
- Keep activities tiny (30-90 seconds). One question at a time.
- If the user seems stuck, offer "Want the short version?" or simplify.
- If the user seems unmotivated, spark interest: "This one helps me learn what days feel best for you."
- Celebrate effort, not correctness. Any answer is a good answer.
- Never guilt or pressure. "That's okay" is always valid.
- When an activity offers choices, genuinely accept any option including "something else".

Personalization (IMPORTANT):
- Always reference what the user just said. Use their exact words when possible.
- Ask about the SPECIFIC details they shared, not generic follow-ups.
- Build on their response to show you're truly listening.
- Connect their answers to feelings, memories, or people when natural.
- The "Suggested follow-up" is a DIRECTION, not a literal question. Personalize it based on their response.

Your job is to gently guide conversation, drawing out memories and stories from the participant.`;

const MAX_TURNS_PER_ACTIVITY = 3; // Max back-and-forth before moving on

interface LLMResponse {
  text: string;
  shouldFollowUp: boolean;
}

async function generateResponse(
  userMessage: string,
  activity: Activity,
  turnNumber: number,
  isClosing: boolean = false
): Promise<LLMResponse> {
  log(`LLM: Generating response (turn ${turnNumber})...`);
  const start = Date.now();

  // Add user message to history
  if (userMessage) {
    conversationHistory.push({ role: "user", content: userMessage });
  }

  // Build context for this specific response
  let contextPrompt = "";
  if (isClosing) {
    contextPrompt = `The session is ending. Generate a personalized closing that:
1. References 1-2 specific things they shared during the session
2. Ends with warmth and encouragement
Keep it to 2-3 sentences.

Respond with JSON: {"text": "your closing message", "followUp": false}`;
  } else {
    // Get follow-up prompts from activity script if available
    const scriptPrompts = activity.script || [];
    const nextScriptPrompt = scriptPrompts[turnNumber] || null;

    contextPrompt = `Activity: ${activity.title || activity.category}
Goal: ${activity.goal || "Engage the participant"}
Instructions: ${activity.instructions || "Draw out their story"}
${nextScriptPrompt ? `Suggested follow-up: "${nextScriptPrompt}"` : ""}

The participant just said: "${userMessage}"

Decide whether to follow up or move on:

MOVE ON (followUp=false) if:
- They gave a negative/dismissive response ("no", "nothing", "I don't know", "not really", "can't think of anything")
- They've shared something meaningful or personal
- They seem disengaged or want to move forward
- This is turn ${turnNumber + 1} of ${MAX_TURNS_PER_ACTIVITY} (don't overstay)

FOLLOW UP (followUp=true) ONLY if:
- Their response is brief but positive/engaged (shows interest but needs gentle prompting)
- There's a clear opportunity to draw out more detail they seem willing to share

${turnNumber >= MAX_TURNS_PER_ACTIVITY - 1 ? "This is the LAST turn - you MUST set followUp=false and wrap up warmly. Do NOT ask a question." : ""}

CRITICAL: Your response text must match your followUp decision:
- If followUp=true: You MUST end with a clear, gentle question so the user knows to respond
- If followUp=false: Give a COMPLETE acknowledgment with NO questions. Do NOT say "How about...", "Let's move on to...", "What about...", or anything that expects a response. Just warmly acknowledge what they shared and stop. The next activity will be introduced automatically.

Respond with JSON: {"text": "your response", "followUp": true/false}`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: contextPrompt }
  ];

  try {
    const response = await withRetry(
      () => openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 200,
        temperature: 0.7,
      }),
      "LLM",
      { logger: log }
    );

    const rawReply = response.choices[0]?.message?.content?.trim() || '{"text": "Thank you for sharing that.", "followUp": false}';

    // Parse JSON response
    let parsed: { text: string; followUp: boolean };
    try {
      // Handle case where LLM wraps in markdown code blocks
      const jsonStr = rawReply.replace(/```json\n?|\n?```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      // Fallback if JSON parsing fails
      log(`LLM: Failed to parse JSON, using raw response`);
      parsed = { text: rawReply, followUp: false };
    }

    // Force followUp=false on last turn (safeguard if LLM ignores instruction)
    if (turnNumber >= MAX_TURNS_PER_ACTIVITY - 1 && parsed.followUp) {
      log(`LLM: Forcing followUp=false (last turn)`);
      parsed.followUp = false;
    }

    log(`LLM: "${parsed.text.slice(0, 50)}..." followUp=${parsed.followUp} in ${Date.now() - start}ms`);

    // Add assistant response to history
    conversationHistory.push({ role: "assistant", content: parsed.text });

    return { text: parsed.text, shouldFollowUp: parsed.followUp };
  } catch (err) {
    log(`LLM: Error - ${err}`);
    return { text: "Thank you for sharing that.", shouldFollowUp: false };
  }
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function checkStopPhrase(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // More strict matching - phrase must be:
  // 1. The entire response, OR
  // 2. At word boundaries (not part of another word like "bye" in "goodbye" or "my cats" misheard as "bye cats")
  return STOP_PHRASES.some(phrase => {
    // Exact match
    if (lower === phrase) return true;

    // Word boundary match using regex
    const regex = new RegExp(`\\b${phrase}\\b`, 'i');
    const match = regex.test(lower);

    // Extra check: if phrase is short (like "bye", "thanks"), require it to be more intentional
    // e.g., "bye" alone or "bye now" but not "bye cats" (likely mishearing)
    if (match && phrase.length <= 4) {
      // Short phrases need to be standalone or followed by common stop words
      const standaloneRegex = new RegExp(`^${phrase}[.!]?$|^${phrase}\\s+(now|for now|coco|there)`, 'i');
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

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await response.arrayBuffer();
  } catch (err) {
    throw new Error(`TTS arrayBuffer failed: ${err instanceof Error ? err.message : err}`);
  }

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

    // Use safeReject to prevent double-rejection (e.g., both stdin error and exit)
    let rejected = false;
    const safeReject = (err: Error) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    };

    aplay.on("error", safeReject);
    aplay.stdin.on("error", safeReject); // Catches EPIPE when audio device unavailable

    aplay.on("exit", (code) => {
      if (rejected) return; // Already rejected via error handler
      if (code === 0) {
        log(`Play: Done in ${Date.now() - start}ms`);
        resolve();
      } else {
        safeReject(new Error(`aplay exited with code ${code}`));
      }
    });

    try {
      aplay.stdin.write(audioBuffer);
      aplay.stdin.end();
    } catch (err) {
      safeReject(err instanceof Error ? err : new Error(String(err)));
    }
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
}

async function recordAudio(): Promise<RecordingResult> {
  if (AUDIO_DISABLED) {
    log(`Record: [DISABLED] Returning empty buffer`);
    return { buffer: Buffer.alloc(0), hasHeardSpeech: false, peakRMS: 0 };
  }

  log(`Record: initial=${INITIAL_RECORD_SECONDS}s, max=${MAX_RECORD_SECONDS}s, silence=${SILENCE_DURATION_MS}ms`);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let silenceStart: number | null = null;
    let hasHeardSpeech = false;
    let peakRMS = 0;
    let lastSpeechTime = 0;
    let currentMaxMs = INITIAL_RECORD_SECONDS * 1000;
    let extended = false;

    const arecord = spawn("arecord", [
      "-t", "raw", "-f", SAMPLE_FORMAT, "-c", String(CHANNELS),
      "-r", String(SAMPLE_RATE), "-q", "-D", INPUT_DEVICE, "-",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    // Check periodically if we should extend or stop
    const checkTimer = setInterval(() => {
      const elapsed = Date.now() - start;

      // If past initial cap, check if still speaking
      if (elapsed >= currentMaxMs) {
        const timeSinceLastSpeech = Date.now() - lastSpeechTime;

        if (!extended && timeSinceLastSpeech < EXTEND_IF_SPEAKING_WITHIN_MS && elapsed < MAX_RECORD_SECONDS * 1000) {
          // User was recently speaking - extend to absolute max
          extended = true;
          currentMaxMs = MAX_RECORD_SECONDS * 1000;
          log(`Record: Extended to ${MAX_RECORD_SECONDS}s (user still speaking)`);
        } else {
          // Time's up
          log(`Record: Max duration reached (${Math.round(elapsed / 1000)}s)`);
          arecord.kill("SIGTERM");
        }
      }
    }, 500);

    const absoluteMaxTimer = setTimeout(() => {
      log(`Record: Absolute max reached`);
      arecord.kill("SIGTERM");
    }, MAX_RECORD_SECONDS * 1000);

    // Use safeReject to prevent double-rejection (e.g., both stdout error and exit)
    let rejected = false;
    const safeReject = (err: Error) => {
      if (!rejected) {
        rejected = true;
        clearInterval(checkTimer);
        clearTimeout(absoluteMaxTimer);
        reject(err);
      }
    };

    arecord.on("error", safeReject);
    arecord.stdout.on("error", safeReject); // Catches device disconnect during recording

    arecord.on("exit", () => {
      if (rejected) return; // Already rejected via error handler
      clearInterval(checkTimer);
      clearTimeout(absoluteMaxTimer);
      const fullBuffer = Buffer.concat(chunks);
      log(`Record: ${fullBuffer.length} bytes, peakRMS=${Math.round(peakRMS)}, speech=${hasHeardSpeech} in ${Date.now() - start}ms`);
      resolve({ buffer: fullBuffer, hasHeardSpeech, peakRMS });
    });

    arecord.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const rms = calculateRMS(chunk);
      peakRMS = Math.max(peakRMS, rms);
      const isSilent = rms < SILENCE_THRESHOLD;

      if (!isSilent) {
        hasHeardSpeech = true;
        silenceStart = null;
        lastSpeechTime = Date.now(); // Track when user last spoke
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

/**
 * Streaming STT with speculative LLM generation.
 *
 * Flow:
 * 1. Open Deepgram live WebSocket
 * 2. Pipe arecord audio to Deepgram
 * 3. On final transcript (speech_final=true): start speculative LLM
 * 4. On UtteranceEnd (2s silence): return with speculative LLM promise
 *
 * The speculative LLM runs during Deepgram's 2s silence detection window,
 * so by the time we know the user is done, the LLM response is often ready.
 */
async function streamingListen(
  activity: Activity,
  turnNumber: number,
  isClosing: boolean = false
): Promise<StreamingResult> {
  if (AUDIO_DISABLED) {
    log(`STT: [DISABLED] Returning empty result`);
    return { transcript: "", speculativeLLM: null, stoppedEarly: false, audioBuffer: Buffer.alloc(0), durationMs: 0 };
  }

  log(`STT: Starting Deepgram stream (utterance_end=${UTTERANCE_END_MS}ms)`);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let accumulatedTranscript = "";
    let speculativeLLM: Promise<LLMResponse> | null = null;
    let arecord: ChildProcess | null = null;
    let resolved = false;
    let hasReceivedSpeech = false;
    const audioChunks: Buffer[] = []; // Capture audio for storage

    // Helper to build result with audio
    const buildResult = (transcript: string, llm: Promise<LLMResponse> | null, stopped: boolean): StreamingResult => {
      const audioBuffer = Buffer.concat(audioChunks);
      const durationMs = Math.round((audioBuffer.length / (SAMPLE_RATE * 2)) * 1000);
      return { transcript, speculativeLLM: llm, stoppedEarly: stopped, audioBuffer, durationMs };
    };

    // Timeout for no speech (use existing config)
    const maxTimeout = setTimeout(() => {
      if (!resolved) {
        log(`STT: Max duration reached (${MAX_RECORD_SECONDS}s)`);
        cleanup();
        resolve(buildResult(accumulatedTranscript, speculativeLLM, false));
      }
    }, MAX_RECORD_SECONDS * 1000);

    // Create Deepgram live connection
    const connection = deepgram.listen.live({
      model: "nova-2",
      language: "en",
      encoding: "linear16",
      sample_rate: SAMPLE_RATE,
      channels: CHANNELS,
      punctuate: true,
      interim_results: true,
      utterance_end_ms: UTTERANCE_END_MS,
      smart_format: true,
      vad_events: true,
    });

    function cleanup() {
      if (resolved) return;
      resolved = true;
      clearTimeout(maxTimeout);

      if (arecord) {
        arecord.kill("SIGTERM");
        arecord = null;
      }

      try {
        connection.requestClose();
      } catch (e) {
        // Ignore close errors
      }
    }

    // Handle connection open
    connection.on(LiveTranscriptionEvents.Open, () => {
      log(`STT: Deepgram connected`);

      // Start arecord and pipe to Deepgram
      arecord = spawn("arecord", [
        "-t", "raw", "-f", SAMPLE_FORMAT, "-c", String(CHANNELS),
        "-r", String(SAMPLE_RATE), "-q", "-D", INPUT_DEVICE, "-",
      ], { stdio: ["ignore", "pipe", "inherit"] });

      arecord.stdout?.on("data", (chunk: Buffer) => {
        audioChunks.push(chunk); // Capture for storage
        try {
          connection.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        } catch (e) {
          // Connection may have closed
        }
      });

      arecord.on("error", (err) => {
        log(`STT: arecord error - ${err.message}`);
        cleanup();
        reject(err);
      });

      arecord.on("exit", (code) => {
        if (!resolved && code !== 0 && code !== null) {
          log(`STT: arecord exited with code ${code}`);
        }
      });
    });

    // Handle transcripts
    connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = data.is_final === true;
      const speechFinal = data.speech_final === true;

      if (!transcript) return;

      if (isFinal) {
        // Accumulate final transcripts
        if (accumulatedTranscript && transcript) {
          accumulatedTranscript += " " + transcript;
        } else {
          accumulatedTranscript = transcript;
        }

        log(`STT: Final "${transcript}" (speech_final=${speechFinal})`);

        // Check for stop phrase immediately
        if (checkStopPhrase(accumulatedTranscript)) {
          log(`STT: Stop phrase detected!`);
          cleanup();
          resolve(buildResult(accumulatedTranscript, null, true));
          return;
        }

        // On speech_final, start speculative LLM generation
        // This gives us ~2s head start before UtteranceEnd
        if (speechFinal && accumulatedTranscript.trim()) {
          hasReceivedSpeech = true;
          log(`STT: Starting speculative LLM...`);
          speculativeLLM = generateResponse(accumulatedTranscript, activity, turnNumber, isClosing);
        }
      } else {
        // Log interim transcripts for debugging
        if (transcript.length > 3) {
          log(`STT: Interim "${transcript}"`);
        }
      }
    });

    // UtteranceEnd = user definitely done speaking (2s silence)
    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      log(`STT: UtteranceEnd after ${Date.now() - start}ms`);
      cleanup();
      resolve(buildResult(accumulatedTranscript, speculativeLLM, false));
    });

    // Handle speech started event
    connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      log(`STT: Speech started`);
      hasReceivedSpeech = true;
    });

    // Handle errors
    connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      log(`STT: Deepgram error - ${err.message || err}`);
      cleanup();
      reject(new Error(`Deepgram error: ${err.message || err}`));
    });

    // Handle connection close
    connection.on(LiveTranscriptionEvents.Close, () => {
      if (!resolved) {
        log(`STT: Connection closed unexpectedly`);
        cleanup();
        resolve(buildResult(accumulatedTranscript, speculativeLLM, false));
      }
    });
  });
}

/**
 * Simple listen wrapper for readiness check (no speculation needed)
 */
async function listenAndTranscribe(): Promise<string> {
  // Use a dummy activity for the readiness check
  const dummyActivity: Activity = { id: "readiness", category: "orientation", prompt: "" };
  const result = await streamingListen(dummyActivity, 0);
  return result.transcript;
}

async function runSession(): Promise<SessionResult> {
  const sessionStart = Date.now();
  const startedAt = new Date().toISOString();
  const transcripts: string[] = [];
  let stoppedEarly = false;

  // Device and participant identifiers from environment
  const deviceId = process.env.COCO_DEVICE_ID ?? process.env.HOSTNAME ?? "unknown-device";
  const participantId = process.env.COCO_PARTICIPANT_ID;
  const userExternalId = process.env.COCO_USER_EXTERNAL_ID ?? participantId;

  // Generate session identifiers
  const { sessionId, planId } = createSessionIdentifiers();

  log("\n========================================");
  log("  COCO SESSION START (Streaming Pipeline)");
  log(`  Session: ${sessionId.slice(0, 8)}...`);
  log("========================================\n");

  // Clear conversation history for new session
  conversationHistory.length = 0;

  // Build activity plan
  const plan = buildPlan();
  log(`Plan: ${plan.map(a => a.category).join(" → ")}`);

  // Intro
  const introMessage = "Hello! I'm Coco, your cognitive companion. I'm happy to spend some time with you today.";
  conversationHistory.push({ role: "assistant", content: introMessage });
  await speak(introMessage);

  // Readiness check - make sure senior is present and ready
  const readinessPrompt = "Are you ready to begin?";
  conversationHistory.push({ role: "assistant", content: readinessPrompt });
  await speak(readinessPrompt);

  let isReady = false;
  let readinessAttempts = 0;
  const MAX_READINESS_ATTEMPTS = 3;

  while (!isReady && readinessAttempts < MAX_READINESS_ATTEMPTS) {
    readinessAttempts++;
    const response = await listenAndTranscribe();

    if (response) {
      log(`Readiness response: "${response}"`);
      // Check if they want to stop
      if (checkStopPhrase(response)) {
        log(`Stop phrase during readiness check`);
        const durationSec = Math.round((Date.now() - sessionStart) / 1000);

        // Send early_exit session summary to backend FIRST (before closing speech)
        const payload: SessionSummaryPayload = {
          session_id: sessionId,
          plan_id: planId,
          user_external_id: userExternalId,
          participant_id: participantId,
          device_id: deviceId,
          started_at: new Date(sessionStart).toISOString(),
          ended_at: new Date().toISOString(),
          duration_seconds: durationSec,
          turn_count: 0,
          status: "early_exit",
          sentiment_summary: "neutral",
          sentiment_score: 0.5,
        };
        await sendSessionSummary(payload);

        // Closing speech (try/catch - summary already sent)
        try {
          await speak("No problem. Take care, and I'll be here when you're ready!");
        } catch (err) {
          log(`Closing speech failed (session data saved): ${err}`);
        }

        return { utteranceCount: 0, durationSec, transcripts: [], stoppedEarly: true };
      }
      // Any response means they're present
      isReady = true;
      transcripts.push(response);
      const acknowledgment = "Great! Let's get started.";
      conversationHistory.push({ role: "assistant", content: acknowledgment });
      await speak(acknowledgment);
    } else {
      log(`No readiness response (attempt ${readinessAttempts}/${MAX_READINESS_ATTEMPTS})`);
      if (readinessAttempts < MAX_READINESS_ATTEMPTS) {
        const retryPrompts = [
          "I'm here when you're ready. Just say hello or yes to begin.",
          "Take your time. Let me know when you'd like to start.",
        ];
        const retryPrompt = retryPrompts[readinessAttempts - 1] || retryPrompts[retryPrompts.length - 1];
        conversationHistory.push({ role: "assistant", content: retryPrompt });
        await speak(retryPrompt);
      }
    }
  }

  // If still no response after all attempts, end as unattended
  if (!isReady) {
    log(`No response after ${MAX_READINESS_ATTEMPTS} readiness attempts - ending session`);
    const durationSec = Math.round((Date.now() - sessionStart) / 1000);

    // Send unattended session summary to backend FIRST (before closing speech)
    const payload: SessionSummaryPayload = {
      session_id: sessionId,
      plan_id: planId,
      user_external_id: userExternalId,
      participant_id: participantId,
      device_id: deviceId,
      started_at: new Date(sessionStart).toISOString(),
      ended_at: new Date().toISOString(),
      duration_seconds: durationSec,
      turn_count: 0,
      status: "unattended",
      sentiment_summary: "neutral",
      sentiment_score: 0.5,
    };
    await sendSessionSummary(payload);

    // Closing speech (try/catch - summary already sent)
    try {
      await speak("I'll be here when you're ready. Take care!");
    } catch (err) {
      log(`Closing speech failed (session data saved): ${err}`);
    }

    return { utteranceCount: 0, durationSec, transcripts: [], stoppedEarly: false };
  }

  // Run each activity
  for (let i = 0; i < plan.length; i++) {
    const activity = plan[i];
    const isLastActivity = i === plan.length - 1;
    log(`\n--- Activity ${i + 1}/${plan.length}: ${activity.category} (${activity.id}) ---`);

    // For closing activity, skip the prompt - we'll generate a personalized closing after their response
    if (isLastActivity) {
      // Just ask a simple closing question
      const closingQuestion = "Before we wrap up, is there anything else on your mind today?";
      conversationHistory.push({ role: "assistant", content: closingQuestion });
      await speak(closingQuestion);
    } else {
      // Initial activity prompt
      const prompt = getActivityPrompt(activity);
      conversationHistory.push({ role: "assistant", content: prompt });
      await speak(prompt);
    }

    // Multi-turn conversation within activity
    let turnNumber = 0;
    let activityComplete = false;
    let listenRetries = 0;

    while (!activityComplete && turnNumber < MAX_TURNS_PER_ACTIVITY) {
      // Use streaming listen with speculative LLM
      const result = await streamingListen(activity, turnNumber, isLastActivity);

      // Handle stop phrase (detected during streaming)
      if (result.stoppedEarly) {
        log(`Stop phrase detected!`);
        if (result.transcript) transcripts.push(result.transcript);
        // Save audio even when stopping early
        if (result.audioBuffer.length > 0) {
          saveRecording(result.audioBuffer, {
            sessionId,
            deviceId,
            participantId,
            turnNumber: transcripts.length,
            activityId: activity.id,
            durationMs: result.durationMs,
          }).catch(err => log(`Audio save failed: ${err}`));
        }
        stoppedEarly = true;
        break;
      }

      if (result.transcript) {
        listenRetries = 0; // Reset retry counter on successful capture
        transcripts.push(result.transcript);
        log(`User (turn ${turnNumber + 1}): "${result.transcript}"`);

        // Save audio recording locally (async, don't block)
        if (result.audioBuffer.length > 0) {
          saveRecording(result.audioBuffer, {
            sessionId,
            deviceId,
            participantId,
            turnNumber: transcripts.length,
            activityId: activity.id,
            durationMs: result.durationMs,
          }).catch(err => log(`Audio save failed: ${err}`));
        }

        // Generate response - use speculative LLM if available
        if (!isLastActivity) {
          let response: LLMResponse;

          if (result.speculativeLLM) {
            // Speculative LLM was started during streaming - await it
            const speculativeStart = Date.now();
            response = await result.speculativeLLM;
            const speculativeWait = Date.now() - speculativeStart;
            if (speculativeWait < 100) {
              log(`LLM: Speculative hit! Response ready (waited ${speculativeWait}ms)`);
            } else {
              log(`LLM: Speculative partial hit (waited ${speculativeWait}ms)`);
            }
          } else {
            // No speculative LLM - generate now
            response = await generateResponse(result.transcript, activity, turnNumber, false);
          }

          await speak(response.text);

          if (response.shouldFollowUp && turnNumber < MAX_TURNS_PER_ACTIVITY - 1) {
            // Continue conversation in this activity
            turnNumber++;
            log(`Continuing activity (turn ${turnNumber + 1})...`);
          } else {
            // Move to next activity
            activityComplete = true;
          }
        } else {
          // For last activity, just add to history for closing
          conversationHistory.push({ role: "user", content: result.transcript });
          activityComplete = true;
        }
      } else {
        // No response captured - retry for seniors
        listenRetries++;
        log(`No response captured (attempt ${listenRetries}/${MAX_LISTEN_RETRIES + 1})`);

        if (listenRetries <= MAX_LISTEN_RETRIES) {
          // Retry - ask them to repeat
          const retryMessages = [
            "I didn't quite catch that. Could you say that again?",
            "I'm sorry, I missed that. One more time?",
            "I'm having trouble hearing. Let's try once more.",
          ];
          const retryMsg = retryMessages[Math.min(listenRetries - 1, retryMessages.length - 1)];
          conversationHistory.push({ role: "assistant", content: retryMsg });
          await speak(retryMsg);
          // Loop continues to listen again
        } else {
          // Max retries reached - move on gracefully
          log(`Max retries reached, moving on`);
          const moveOnMsg = "That's okay, let's move on to the next part.";
          conversationHistory.push({ role: "assistant", content: moveOnMsg });
          await speak(moveOnMsg);
          activityComplete = true;
        }
      }
    }

    if (stoppedEarly) break;
  }

  // Calculate duration and status BEFORE closing speech
  // This ensures we can send session summary even if closing fails
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

  // Send session summary to backend BEFORE closing speech
  // Critical: ensures data is saved even if closing speech fails
  const payload: SessionSummaryPayload = {
    session_id: sessionId,
    plan_id: planId,
    user_external_id: userExternalId,
    participant_id: participantId,
    device_id: deviceId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSec,
    turn_count: transcripts.length,
    status,
    sentiment_summary: status === "unattended" ? "neutral" : "positive",
    sentiment_score: status === "unattended" ? 0.5 : 0.75,
    notes: rateLimitEvents.length > 0
      ? `Rate limits hit: ${rateLimitEvents.map(e => `${e.label}@${e.timestamp}`).join(", ")}`
      : undefined,
  };

  await sendSessionSummary(payload);

  // Process audio upload queue (async, best-effort)
  try {
    await processUploadQueue();
    cleanupOldRecordings();
  } catch (err) {
    log(`Audio queue processing failed: ${err}`);
  }

  // Personalized closing (wrapped in try/catch - summary already sent)
  try {
    if (!stoppedEarly && transcripts.length > 0) {
      // Generate personalized closing based on session
      const closingActivity = plan[plan.length - 1];
      const closingResponse = await generateResponse("", closingActivity, 0, true);
      await speak(closingResponse.text);
    } else if (stoppedEarly) {
      await speak("It was lovely chatting with you. Take care!");
    } else {
      await speak("Thank you for spending this time with me. Take care, and I'll see you next time!");
    }
  } catch (closingErr) {
    // Log but don't throw - session summary already sent
    log(`Closing speech failed (session data saved): ${closingErr}`);
  }

  // Close audio database
  closeAudioDb();

  return {
    utteranceCount: transcripts.length,
    durationSec,
    transcripts,
    stoppedEarly,
  };
}

// Exit codes:
// 0 = success (had conversations)
// 1 = error (exception/crash)
// 2 = unattended (no one present)
// 3 = early_exit (user said stop phrase)

async function main() {
  const deviceId = process.env.COCO_DEVICE_ID ?? process.env.HOSTNAME ?? "unknown-device";
  const participantId = process.env.COCO_PARTICIPANT_ID;
  const userExternalId = process.env.COCO_USER_EXTERNAL_ID ?? participantId;

  try {
    const result = await runSession();

    console.log("\nSession Result:");
    console.log(JSON.stringify(result, null, 2));

    // Exit code based on result
    if (result.utteranceCount === 0) {
      if (result.stoppedEarly) {
        process.exit(3); // Early exit - user said stop phrase
      }
      process.exit(2); // Unattended - no one present
    }
    process.exit(0); // Success
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.constructor.name : "UnknownError";

    console.error("Session error:", err);
    log(`FATAL: Session crashed - ${errorType}: ${errorMessage}`);

    // Report error to backend via session_summary with error_exit status
    try {
      await sendSessionStartFailed({
        device_id: deviceId,
        participant_id: participantId,
        user_external_id: userExternalId,
        error_type: errorType,
        error_message: errorMessage,
        timestamp: new Date().toISOString(),
      });
    } catch (reportErr) {
      console.error("Failed to report error to backend:", reportErr);
    }

    process.exit(1); // Error
  }
}

main();
