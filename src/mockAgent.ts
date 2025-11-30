import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

import { Activity, buildPlan } from "./planner";
import {
  createSessionIdentifiers,
  sendSessionSummary,
} from "./backend";
import { toLocalISO } from "./logger";

const LOG_PATH =
  process.env.COCO_ACTIVITY_LOG_PATH ??
  path.join(process.cwd(), "agent-activity.log");

const INTRO_LINE =
  process.env.COCO_MOCK_INTRO_LINE ??
  "Hi there, I'm Coco. How are you feeling today?";
const CLOSING_LINE =
  process.env.COCO_MOCK_CLOSING_LINE ??
  "Thank you for sharing that with me. Let's wrap up for now.";
const TEXT_FALLBACK_PROMPT =
  process.env.COCO_MOCK_TEXT_PROMPT ??
  "How are you feeling today?";
const MICROPHONE_WINDOW_MS = Math.max(
  1000,
  Number(process.env.COCO_MOCK_MICROPHONE_WINDOW_MS ?? "8000"),
);
const AUDIO_SAMPLE_RATE = Number(process.env.COCO_AUDIO_SAMPLE_RATE ?? "24000");
const AUDIO_CHANNELS = Number(process.env.COCO_AUDIO_CHANNELS ?? "1");
const AUDIO_SAMPLE_FORMAT = process.env.COCO_AUDIO_SAMPLE_FORMAT ?? "S16_LE";
const AUDIO_INPUT_DEVICE = process.env.COCO_AUDIO_INPUT_DEVICE ?? "pulse";
const CUSTOM_TTS_COMMAND = process.env.COCO_MOCK_TTS_COMMAND;
const CUSTOM_TTS_ARGS = parseArgList(process.env.COCO_MOCK_TTS_ARGS);
const CUSTOM_CAPTURE_COMMAND = process.env.COCO_MOCK_CAPTURE_COMMAND;
const CUSTOM_CAPTURE_ARGS = parseArgList(process.env.COCO_MOCK_CAPTURE_ARGS);
type AudioProfile = "device" | "mac";

type CommandConfig = {
  label: string;
  command: string;
  args: string[];
  platform?: NodeJS.Platform;
};

type TtsConfig = CommandConfig & {
  appendText: boolean;
};

function resolveAudioProfile(): AudioProfile {
  const raw = (process.env.COCO_MOCK_AUDIO_PROFILE ?? "").toLowerCase();
  if (raw === "mac" || raw === "device") {
    return raw;
  }
  return process.platform === "darwin" ? "mac" : "device";
}

const AUDIO_PROFILE: AudioProfile = resolveAudioProfile();

function parseArgList(raw?: string) {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed as string[];
    }
    console.warn(
      "[mock-agent] Ignoring custom args; expected a JSON string array.",
    );
  } catch (error) {
    console.warn("[mock-agent] Failed to parse custom args JSON:", error);
  }
  return undefined;
}

const POSITIVE_WORDS = [
  "good",
  "great",
  "calm",
  "happy",
  "grateful",
  "relaxed",
  "excited",
  "fantastic",
  "hopeful",
];
const NEGATIVE_WORDS = [
  "bad",
  "sad",
  "anxious",
  "tired",
  "stressed",
  "upset",
  "angry",
  "worried",
  "overwhelmed",
];

type SentimentResult = {
  score: number;
  summary: string;
  basis: "audio" | "text" | "default";
};

type CaptureResult = {
  audio?: Buffer;
  text?: string;
  durationMs: number;
};

const DEFAULT_SENTIMENT_SUMMARY =
  process.env.COCO_SENTIMENT_SUMMARY ?? "neutral";
const DEFAULT_SENTIMENT_SCORE = (() => {
  const raw = Number(process.env.COCO_SENTIMENT_SCORE ?? "0.5");
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
})();
const DEFAULT_SENTIMENT: SentimentResult = {
  score: DEFAULT_SENTIMENT_SCORE,
  summary: DEFAULT_SENTIMENT_SUMMARY,
  basis: "default",
};

function createLinuxTtsConfig(): TtsConfig {
  return {
    label: "linux-spd-say",
    command: "spd-say",
    args: ["-w"],
    platform: "linux",
    appendText: true,
  };
}

function createMacTtsConfig(): TtsConfig {
  return {
    label: "mac-say",
    command: "say",
    args: [],
    platform: "darwin",
    appendText: true,
  };
}

function resolveTtsConfig(): TtsConfig | null {
  if (CUSTOM_TTS_COMMAND) {
    return {
      label: "custom-tts",
      command: CUSTOM_TTS_COMMAND,
      args:
        CUSTOM_TTS_ARGS ??
        (CUSTOM_TTS_COMMAND === "spd-say" ? ["-w"] : []),
      appendText: true,
    };
  }
  return AUDIO_PROFILE === "mac" ? createMacTtsConfig() : createLinuxTtsConfig();
}

function createLinuxCaptureConfig(): CommandConfig {
  return {
    label: "linux-arecord",
    command: "arecord",
    args: [
      "-t",
      "raw",
      "-f",
      AUDIO_SAMPLE_FORMAT,
      "-c",
      String(AUDIO_CHANNELS),
      "-r",
      String(AUDIO_SAMPLE_RATE),
      "-D",
      AUDIO_INPUT_DEVICE,
      "-q",
      "-",
    ],
    platform: "linux",
  };
}

function createMacCaptureConfig(): CommandConfig {
  if (AUDIO_SAMPLE_FORMAT !== "S16_LE") {
    console.warn(
      `[mock-agent] mac audio profile assumes S16_LE input; overriding COCO_AUDIO_SAMPLE_FORMAT=${AUDIO_SAMPLE_FORMAT}.`,
    );
  }
  return {
    label: "mac-sox",
    command: "sox",
    args: [
      "-d",
      "-t",
      "raw",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-c",
      String(AUDIO_CHANNELS),
      "-r",
      String(AUDIO_SAMPLE_RATE),
      "-L",
      "-",
    ],
    platform: "darwin",
  };
}

function resolveCaptureConfig(): CommandConfig | null {
  if (CUSTOM_CAPTURE_COMMAND) {
    return {
      label: "custom-capture",
      command: CUSTOM_CAPTURE_COMMAND,
      args: CUSTOM_CAPTURE_ARGS ?? [],
    };
  }
  return AUDIO_PROFILE === "mac"
    ? createMacCaptureConfig()
    : createLinuxCaptureConfig();
}

const TTS_CONFIG = resolveTtsConfig();
const CAPTURE_CONFIG = resolveCaptureConfig();

async function appendLog(lines: string[]) {
  const payload = `${lines.join("\n")}\n`;
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.appendFile(LOG_PATH, payload, "utf8");
}

function logLine(lines: string[], message: string) {
  const timestamp = toLocalISO();
  lines.push(`[${timestamp}] ${message}`);
}

async function speakLine(text: string, label: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  console.log(`[mock-agent] (${label}) ${trimmed}`);
  if (process.env.COCO_MOCK_DISABLE_TTS === "1") {
    return;
  }
  const config = TTS_CONFIG;
  if (!config) {
    console.warn(
      `[mock-agent] No TTS command configured for audio profile "${AUDIO_PROFILE}".`,
    );
    return;
  }
  if (config.platform && config.platform !== process.platform) {
    console.warn(
      `[mock-agent] TTS command "${config.label}" requires ${config.platform}, but current platform is ${process.platform}.`,
    );
    return;
  }
  const args = config.appendText ? [...config.args, trimmed] : config.args;
  await new Promise<void>((resolve) => {
    const proc = spawn(config.command, args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    proc.on("error", (error) => {
      console.warn(
        `[mock-agent] Failed to run ${config.command} (${config.label}):`,
        error,
      );
      resolve();
    });
    proc.on("close", () => resolve());
  });
}

async function captureTypedResponse(): Promise<CaptureResult> {
  const autoReply =
    process.env.COCO_MOCK_AUTO_REPLY ?? process.env.COCO_MOCK_AUTO_INPUT;
  if (autoReply !== undefined) {
    const text = autoReply === "" ? "ok" : autoReply;
    console.log(`[mock-agent] (auto-reply) ${text}`);
    return { text, durationMs: 0 };
  }
  const rl = readline.createInterface({ input, output });
  return new Promise<CaptureResult>((resolve) => {
    rl.question(`${TEXT_FALLBACK_PROMPT} `, (answer) => {
      rl.close();
      resolve({ text: answer, durationMs: 0 });
    });
  });
}

function recordMicrophone(
  config: CommandConfig,
  durationMs: number,
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.command, config.args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    const captureStart = Date.now();
    const timer = setTimeout(() => proc.kill("SIGINT"), durationMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code && code !== 0 && signal !== "SIGINT") {
        reject(new Error(`arecord exited with code ${code}`));
        return;
      }
      resolve({
        audio: Buffer.concat(chunks),
        durationMs: Date.now() - captureStart,
      });
    });
  });
}

async function captureParticipantTurn(): Promise<CaptureResult> {
  const config = CAPTURE_CONFIG;
  if (!config) {
    console.warn(
      `[mock-agent] Microphone capture unavailable for profile "${AUDIO_PROFILE}". Using typed input instead.`,
    );
    return captureTypedResponse();
  }
  if (config.platform && config.platform !== process.platform) {
    console.warn(
      `[mock-agent] Microphone command "${config.label}" requires ${config.platform}, but current platform is ${process.platform}. Falling back to text input.`,
    );
    return captureTypedResponse();
  }
  try {
    console.log(
      `[mock-agent] Listening for up to ${Math.round(MICROPHONE_WINDOW_MS / 1000)} seconds using ${config.label}...`,
    );
    return await recordMicrophone(config, MICROPHONE_WINDOW_MS);
  } catch (error) {
    console.warn(
      `[mock-agent] Microphone capture via ${config.label} failed, falling back to text input:`,
      error,
    );
    return captureTypedResponse();
  }
}

function summarizePlan(plan: Activity[]) {
  console.log("[mock-agent] Today's plan:");
  plan.forEach((step, index) => {
    const title =
      step.prompt ??
      step.instructions ??
      step.trials?.[0] ??
      "Untitled activity";
    console.log(
      `  ${index + 1}. ${step.category} (${step.domain ?? "general"}) → ${title}`,
    );
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function describeScore(score: number) {
  if (score >= 0.65) {
    return "positive";
  }
  if (score <= 0.35) {
    return "negative";
  }
  return "neutral";
}

function sentimentFromAudio(buffer?: Buffer): SentimentResult | null {
  if (!buffer || buffer.length < 2) {
    return null;
  }
  if (AUDIO_SAMPLE_FORMAT !== "S16_LE") {
    return null;
  }
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) {
    return null;
  }
  let sumSquares = 0;
  let zeroCrossings = 0;
  let prevSign = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = buffer.readInt16LE(i * 2) / 32768;
    sumSquares += sample * sample;
    const sign = sample === 0 ? prevSign : sample > 0 ? 1 : -1;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      zeroCrossings += 1;
    }
    prevSign = sign;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  const zeroCrossRatio = zeroCrossings / sampleCount;
  const normalizedRms = clamp(rms / 0.35, 0, 1);
  const normalized = clamp(
    normalizedRms * 0.7 + clamp(zeroCrossRatio * 3, 0, 1) * 0.3,
    0,
    1,
  );
  return {
    score: Number(normalized.toFixed(3)),
    summary: describeScore(normalized),
    basis: "audio",
  };
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .match(/[a-z']+/g)
    ?.filter(Boolean) ?? [];
}

function sentimentFromText(text?: string): SentimentResult | null {
  if (!text || !text.trim()) {
    return null;
  }
  const tokens = tokenize(text);
  if (!tokens.length) {
    return null;
  }
  let value = 0;
  tokens.forEach((token) => {
    if (POSITIVE_WORDS.includes(token)) {
      value += 1;
    }
    if (NEGATIVE_WORDS.includes(token)) {
      value -= 1;
    }
  });
  const normalized = clamp(0.5 + value / (tokens.length * 2), 0, 1);
  return {
    score: Number(normalized.toFixed(3)),
    summary: describeScore(normalized),
    basis: "text",
  };
}

function computeSentiment(result: CaptureResult): SentimentResult {
  return (
    sentimentFromAudio(result.audio) ??
    sentimentFromText(result.text) ??
    DEFAULT_SENTIMENT
  );
}

export async function runMockAgentSession() {
  const plan = buildPlan();
  summarizePlan(plan);
  console.log(
    `[mock-agent] Audio profile: ${AUDIO_PROFILE} (tts=${TTS_CONFIG?.label ?? "off"}, mic=${CAPTURE_CONFIG?.label ?? "off"})`,
  );

  const { sessionId, planId } = createSessionIdentifiers();
  const participantId =
    process.env.COCO_PARTICIPANT_ID ??
    "f654fecf-3805-4eba-b66d-65ec0e3ecbff";
  const deviceId = process.env.COCO_DEVICE_ID ?? "mock-device";
  const label = process.env.COCO_SESSION_LABEL ?? "tyngo";
  const tsStart = new Date();

  const header =
    `---\n` +
    `[${toLocalISO(tsStart)}] mock session ${sessionId} started (plan=${planId}, participant=${participantId}, device=${deviceId})`;
  const logLines = [header];

  await speakLine(INTRO_LINE, "intro");
  logLine(logLines, "Played intro line.");
  logLine(logLines, "Prompting participant for microphone input.");
  const captureResult = await captureParticipantTurn();
  if (captureResult.audio) {
    logLine(
      logLines,
      `Captured ${captureResult.audio.length} bytes of microphone audio (${captureResult.durationMs} ms).`,
    );
  } else {
    logLine(
      logLines,
      `Captured typed response (${captureResult.text?.length ?? 0} chars).`,
    );
  }

  await speakLine(CLOSING_LINE, "closing");
  logLine(logLines, "Played closing line.");

  const tsEnd = new Date();
  const sentiment = computeSentiment(captureResult);
  logLine(
    logLines,
    `Sentiment score=${sentiment.score} summary=${sentiment.summary} basis=${sentiment.basis}.`,
  );

  const planSummary = plan
    .map(
      (step, index) =>
        `${index + 1}.${step.category}:${step.id ?? "n/a"}(${step.domain ?? "general"})`,
    )
    .join(", ");
  logLine(logLines, `Plan recap: ${planSummary}`);
  logLine(
    logLines,
    `mock session ${sessionId} ended (turns=2, duration=${Math.round(
      (tsEnd.getTime() - tsStart.getTime()) / 1000,
    )}s)`,
  );

  await appendLog(logLines);

  const summaryPayload = {
    session_id: sessionId,
    plan_id: planId,
    user_external_id: participantId,
    participant_id: participantId,
    device_id: deviceId,
    label,
    started_at: toLocalISO(tsStart),
    ended_at: toLocalISO(tsEnd),
    duration_seconds: Math.max(
      1,
      Math.round((tsEnd.getTime() - tsStart.getTime()) / 1000),
    ),
    turn_count: 2,
    status: "success" as const,
    sentiment_summary: sentiment.summary,
    sentiment_score: sentiment.score,
    notes:
      process.env.COCO_SESSION_NOTES ??
      `Mock session (${sentiment.basis} sentiment, plan: ${planSummary})`,
  };

  await sendSessionSummary(summaryPayload);

  console.log(
    `[mock-agent] Session ${sessionId} completed with sentiment ${sentiment.summary} (${sentiment.score}).`,
  );

  return {
    logPath: LOG_PATH,
    sessionId,
    planId,
    startedAt: tsStart,
    endedAt: tsEnd,
  };
}
