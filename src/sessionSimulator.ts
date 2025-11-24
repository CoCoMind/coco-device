import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import { Activity, buildPlan } from "./planner";
import { createSessionIdentifiers, sendSessionSummary } from "./backend";

const OUTPUT_DIR =
  process.env.COCO_SIM_OUTPUT_DIR ?? path.join(process.cwd(), "sim-output");
const RESPONDER_MODEL =
  process.env.COCO_SIM_RESPONDER_MODEL ?? "gpt-4o-mini";
const VOICE_MODEL =
  process.env.COCO_SIM_VOICE_MODEL ?? "gpt-4o-mini-tts";
const VOICE = process.env.COCO_SIM_VOICE ?? "alloy";
const DEFAULT_SENTIMENT_SUMMARY =
  process.env.COCO_SENTIMENT_SUMMARY ?? "positive";
const DEFAULT_SENTIMENT_SCORE = (() => {
  const raw = Number(process.env.COCO_SENTIMENT_SCORE ?? "0.75");
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.75;
})();
const BASE_ACTIVITY_DELAY_MS = Number(
  process.env.COCO_SIM_ACTIVITY_DELAY_MS ?? "5000"
);
const MIN_ACTIVITY_DELAY_MS = Number(
  process.env.COCO_SIM_MIN_ACTIVITY_DELAY_MS ?? "1000"
);
const OFFLINE_MODE =
  process.env.COCO_SIM_OFFLINE === "1" ||
  process.env.COCO_SIM_OFFLINE === "true";
const MOCK_RESPONSES = [
  "Thanks for guiding me through this—I'm ready for the next one.",
  "I appreciate how gentle that was. Let's keep it going.",
  "That was fun. I'm curious about what comes next.",
  "Feeling calm and focused. Lead the way.",
];

type TranscriptTurn = {
  speaker: "coach" | "participant";
  text: string;
  activity_id?: string;
  category?: string;
  audio_path?: string;
};

type BackendCall = {
  endpoint: string;
  payload: unknown;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function getSimulatedDelayMs(step: Activity) {
  const duration = Number(step.duration_min ?? 1);
  const scaled = Math.max(1, duration);
  return Math.max(MIN_ACTIVITY_DELAY_MS, Math.round(BASE_ACTIVITY_DELAY_MS * scaled));
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function synthesizeParticipantResponse(
  client: OpenAI,
  step: Activity,
  coachLine: string,
  idx: number
) {
  if (OFFLINE_MODE) {
    const text =
      step.demo_response ??
      MOCK_RESPONSES[idx % MOCK_RESPONSES.length] ??
      "Thanks, that sounds good.";
    const filename = path.join(
      OUTPUT_DIR,
      `${String(idx + 1).padStart(2, "0")}-${step.id}.mp3`
    );
    await fs.writeFile(filename, Buffer.alloc(0));
    return { text, audioPath: filename };
  }

  const response = await client.responses.create({
    model: RESPONDER_MODEL,
    input: [
      {
        role: "system",
        content:
          "You are a supportive adult participating in a cognitive coaching session. Respond in 1-2 friendly sentences.",
      },
      {
        role: "user",
        content: `Coach prompt: "${coachLine}". Activity type: ${step.category}. Domain: ${
          step.domain ?? "general"
        }. Provide the words you would speak.`,
      },
    ],
  });

  const text = (response.output_text ?? "").trim() || "Thanks, that sounds good.";

  const speech = await client.audio.speech.create({
    model: VOICE_MODEL,
    voice: VOICE,
    response_format: "mp3",
    input: text,
  });

  const audioBuffer = Buffer.from(await speech.arrayBuffer());
  const filename = path.join(
    OUTPUT_DIR,
    `${String(idx + 1).padStart(2, "0")}-${step.id}.mp3`
  );
  await fs.writeFile(filename, audioBuffer);

  return { text, audioPath: filename };
}

export async function runSimulatedSession() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY before running the simulator.");
  }

  const openai = new OpenAI({ apiKey });
  await ensureDir(OUTPUT_DIR);

  const plan = buildPlan();
  const { sessionId, planId } = createSessionIdentifiers();
  const tsStart = new Date();
  const participantId = process.env.COCO_PARTICIPANT_ID ?? "sim-participant";
  const deviceId = process.env.COCO_DEVICE_ID ?? "sim-device";
  const label = process.env.COCO_SESSION_LABEL ?? "simulated-session";

  const backendCalls: BackendCall[] = [];
  const transcript: TranscriptTurn[] = [];

  const recordCall = (endpoint: string, payload: unknown) => {
    backendCalls.push({ endpoint, payload });
    console.log(`[backend] POST ${endpoint}`, JSON.stringify(payload));
  };

  let turnCount = 0;

  for (const [index, step] of plan.entries()) {
    const coachLine =
      step.prompt ?? step.instructions ?? step.trials?.[0] ?? "Let's continue.";
    transcript.push({
      speaker: "coach",
      text: coachLine,
      activity_id: step.id,
      category: step.category,
    });

    const participant = await synthesizeParticipantResponse(
      openai,
      step,
      coachLine,
      index
    );
    transcript.push({
      speaker: "participant",
      text: participant.text,
      activity_id: step.id,
      category: step.category,
      audio_path: participant.audioPath,
    });
    turnCount += 2;

    await sleep(getSimulatedDelayMs(step));
  }

  const closingLine =
    "Great work today. Take a breath and enjoy the rest of your day.";
  transcript.push({ speaker: "coach", text: closingLine });

  const tsEnd = new Date();
  const totalDurationSec = Math.round((tsEnd.getTime() - tsStart.getTime()) / 1000);
  const summaryPayload = {
    session_id: sessionId,
    plan_id: planId,
    user_external_id: participantId,
    participant_id: participantId,
    device_id: deviceId,
    label,
    started_at: tsStart.toISOString(),
    ended_at: tsEnd.toISOString(),
    duration_seconds: totalDurationSec,
    turn_count: turnCount,
    sentiment_summary: DEFAULT_SENTIMENT_SUMMARY,
    sentiment_score: DEFAULT_SENTIMENT_SCORE,
    notes: process.env.COCO_SESSION_NOTES,
  };
  recordCall("/internal/ingest/session_summary", summaryPayload);
  await sendSessionSummary(summaryPayload);

  const transcriptPath = path.join(
    OUTPUT_DIR,
    `session-${sessionId}-transcript.json`
  );
  await fs.writeFile(
    transcriptPath,
    JSON.stringify({ transcript, backendCalls }, null, 2)
  );

  console.log("\nSession simulation complete.");
  console.log(`Transcript saved to ${transcriptPath}`);
  console.log(
    `Audio clips saved to ${OUTPUT_DIR} (one MP3 per participant response).`
  );
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runSimulatedSession().catch((err) => {
    console.error("Simulation failed:", err);
    process.exitCode = 1;
  });
}
