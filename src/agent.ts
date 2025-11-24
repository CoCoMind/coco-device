import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import OpenAI from "openai";
import { Activity, buildPlan } from "./planner";
import { createSessionIdentifiers, sendSessionSummary } from "./backend";
import { tools } from "./tools";
import { ALSA_SAMPLE_RATE, createAlsaAudioBinding } from "./audioIO";

export const REALTIME_MODEL =
  process.env.REALTIME_MODEL ?? "gpt-4o-mini-realtime-preview-2024-12-17";

const systemPrompt = `You are Coco, a warm, research-backed cognitive coach. Immediately run a single ~10-minute session:
- 4–6 short activities, ~1–2 min each.
- Balance stimulation (language/memory/attention) and relaxation (reminiscence/mood/music).
- Be conversational, supportive, concise; give hints over corrections; praise effort.

Evidence base to cover across the set: CST, SR or EL, CR/goal support, language fluency, reminiscence, attention/dual-task, light musical or mood coda.

Sequence:
1) Orientation (~1)
2) Language or Memory (~2)
3) Spaced Retrieval or Errorless (~2)
4) Attention/Reasoning (~2)
5) Reminiscence/Goal (~2)
6) Closing/Mood/Musical coda (~1)

For each step:
- Introduce briefly (≤1 sentence), present the prompt/trial, pause to listen, then encourage.
- If user says “skip” or seems tired, shorten remaining steps.
Return metadata with each turn: {activity_id, category, domain, duration_min}.
End with a single positive closing line.
Start immediately on connect (do not wait for the user to speak).`;

type SayOptions = {
  timeoutMs?: number;
};

const INTRO_RESPONSE_WINDOW_MS = Number(
  process.env.COCO_INTRO_RESPONSE_WINDOW_MS ?? "5000",
);
const MIN_LISTEN_WINDOW_MS = Number(
  process.env.COCO_MIN_LISTEN_WINDOW_MS ?? "15000",
);
const MAX_LISTEN_WINDOW_MS = Number(
  process.env.COCO_MAX_LISTEN_WINDOW_MS ?? "45000",
);
const FINAL_RESPONSE_WINDOW_MS = Number(
  process.env.COCO_FINAL_RESPONSE_WINDOW_MS ?? "4000",
);

type SentimentSnapshot = {
  summary: string;
  score: number;
};

function extractTextFromMessage(item: any): string {
  const content = item?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((segment) => {
        if (typeof segment === "string") return segment;
        if (segment?.type === "input_text" && typeof segment.text === "string") {
          return segment.text;
        }
        if (segment?.type === "text" && typeof segment.text === "string") {
          return segment.text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

async function scoreSentimentFromTranscript(
  utterances: string[],
): Promise<SentimentSnapshot | null> {
  if (!utterances.length) {
    return null;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[sentiment] OPENAI_API_KEY missing; skipping sentiment scoring.");
    return null;
  }
  const client = new OpenAI({ apiKey });
  const transcript = utterances.join("\n").slice(0, 4000);
  try {
    const response = await client.responses.create({
      model: process.env.COCO_SENTIMENT_MODEL ?? "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "You are a concise sentiment rater. Given a participant transcript, return JSON with fields {\"summary\": \"positive|neutral|negative\", \"score\": number between 0 and 1} reflecting overall affect.",
        },
        { role: "user", content: `Transcript:\n${transcript}` },
      ],
    });
    const raw = (response.output_text ?? "").trim();
    const parsed = JSON.parse(raw) as Partial<SentimentSnapshot>;
    if (
      parsed &&
      typeof parsed.summary === "string" &&
      typeof parsed.score === "number" &&
      Number.isFinite(parsed.score)
    ) {
      const clamped = Math.min(1, Math.max(0, parsed.score));
      return { summary: parsed.summary, score: clamped };
    }
    console.warn("[sentiment] Unexpected sentiment response; raw output:", raw);
  } catch (error) {
    console.error("[sentiment] Failed to score sentiment:", error);
  }
  return null;
}

function clampParticipantWindow(durationMin?: number) {
  const baseMin = Math.max(0.5, durationMin ?? 1);
  const derivedMs = Math.round(baseMin * 60_000);
  return Math.min(
    MAX_LISTEN_WINDOW_MS,
    Math.max(MIN_LISTEN_WINDOW_MS, derivedMs),
  );
}

function waitForAgentTurn(
  session: RealtimeSession,
  timeoutMs: number = 60000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      cleanup();
      console.debug("[realtime] agent turn completed");
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      const normalized =
        error instanceof Error
          ? error
          : new Error(
              typeof error === "object"
                ? JSON.stringify(error)
                : String(error ?? "unknown"),
            );
      console.error("[realtime] session error:", normalized);
      reject(normalized);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("Timed out waiting for agent response"));
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    (timer as NodeJS.Timeout).unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      session.off("agent_end", onEnd);
      session.off("error", onError);
    };
    session.once("agent_end", onEnd);
    session.once("error", onError);
  });
}

async function sessionSay(
  session: RealtimeSession,
  text: string,
  options?: SayOptions,
) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const waitPromise = waitForAgentTurn(
    session,
    options?.timeoutMs ?? 60000,
  );
  session.transport.sendEvent({
    type: "response.create",
    response: {
      instructions: [
        "Speak directly to the participant in a warm, upbeat tone. Keep it concise and supportive.",
        `Guidance: ${trimmed}`,
      ].join("\n"),
    },
  });
  await waitPromise;
  clearTransportAudioState(session);
}

async function waitForParticipantExchange(
  session: RealtimeSession,
  timeoutMs: number,
) {
  if (timeoutMs <= 0) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const onHistoryAdded = (item: unknown) => {
      const candidate = item as { type?: string; role?: string } | undefined;
      if (!candidate || candidate.type !== "message" || candidate.role !== "user") {
        return;
      }
      cleanup();
      resolve(true);
    };
    const onTimeout = () => {
      cleanup();
      console.warn(
        `[realtime] No participant response within ${timeoutMs} ms; continuing.`,
      );
      resolve(false);
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    (timer as NodeJS.Timeout).unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      session.off("history_added", onHistoryAdded);
    };
    session.on("history_added", onHistoryAdded);
  });
}

function clearTransportAudioState(session: RealtimeSession) {
  const transport = session.transport as {
    interrupt?: (cancelOngoingResponse?: boolean) => void;
  };
  if (typeof transport?.interrupt === "function") {
    try {
      transport.interrupt(false);
    } catch (error) {
      console.debug("[realtime] transport interrupt noop:", error);
    }
  }
}

export function createAgent() {
  return new RealtimeAgent({
    name: process.env.COCO_AGENT_NAME ?? "Coco Coach",
    instructions: systemPrompt,
    tools,
  });
}

export async function startSession(ephemeralKey: string) {
  const agent = createAgent();
  const session = new RealtimeSession(agent, {
    model: REALTIME_MODEL,
    transport: "websocket",
    config: {
      audio: {
        input: {
          format: { type: "audio/pcm", rate: ALSA_SAMPLE_RATE },
        },
        output: {
          format: { type: "audio/pcm", rate: ALSA_SAMPLE_RATE },
        },
      },
    },
    // voice/audio can also be set via a session.update after connect
  });
  const audioBinding = createAlsaAudioBinding(session);
  let historyListener: ((item: unknown) => void) | null = null;

  try {
    const participantUtterances: string[] = [];
    historyListener = (item: unknown) => {
      const candidate = item as { type?: string; role?: string } | undefined;
      if (!candidate || candidate.type !== "message" || candidate.role !== "user") {
        return;
      }
      const text = extractTextFromMessage(candidate);
      if (text) {
        participantUtterances.push(text);
      }
    };

    // Connect to Realtime (WebRTC in browser, WS in Node)
    await session.connect({ apiKey: ephemeralKey });
    audioBinding.start();
    if (historyListener) {
      session.on("history_added", historyListener);
    }

    // Immediately kick off the curriculum (no user utterance required)
    // 1) Build the plan
    const plan = buildPlan() as Activity[];
    const { sessionId, planId } = createSessionIdentifiers();
    const tsStart = new Date();
    const envParticipantId = process.env.COCO_PARTICIPANT_ID;
    const userExternalId =
      process.env.COCO_USER_EXTERNAL_ID ??
      envParticipantId ??
      process.env.HOSTNAME ??
      "local-participant";
    const participantId = envParticipantId ?? userExternalId;
    if (!envParticipantId && !process.env.COCO_USER_EXTERNAL_ID) {
      console.warn(
        `[backend] COCO_PARTICIPANT_ID/COCO_USER_EXTERNAL_ID not set; defaulting to "${userExternalId}".`,
      );
    }
    const deviceId =
      process.env.COCO_DEVICE_ID ?? process.env.HOSTNAME ?? "local-device";
    if (!process.env.COCO_DEVICE_ID) {
      console.warn(
        `[backend] COCO_DEVICE_ID not set; defaulting to "${deviceId}".`,
      );
    }
    const label =
      process.env.COCO_SESSION_LABEL ?? "coco-realtime-autostart-session";

    // 2) Ask the agent to run it step-by-step with voice output
    await sessionSay(
      session,
      "Let's begin. I'll guide you through a brief set of activities.",
    );

    await waitForParticipantExchange(session, INTRO_RESPONSE_WINDOW_MS);

    let turnCount = 0;

    for (const step of plan) {
      const line =
        step.prompt ?? step.instructions ?? (step.trials?.[0] ?? "");
      await sessionSay(session, line);
      turnCount += 1;
      const listenWindowMs = clampParticipantWindow(step.duration_min);
      await waitForParticipantExchange(session, listenWindowMs);
      // (The agent’s default turn-taking now waits for the participant before advancing.)
      // telemetry tool call skipped in standalone runner

    }

    await sessionSay(
      session,
      "Great work today. Take a breath and enjoy the rest of your day.",
    );
    await waitForParticipantExchange(session, FINAL_RESPONSE_WINDOW_MS);
    const tsEnd = new Date();
    const totalDurationSec = Math.round(
      (tsEnd.getTime() - tsStart.getTime()) / 1000
    );
    const sentiment =
      (await scoreSentimentFromTranscript(participantUtterances)) ?? {
        summary: "no_input",
        score: 0,
      };
    await sendSessionSummary({
      session_id: sessionId,
      plan_id: planId,
      user_external_id: userExternalId,
      participant_id: participantId,
      device_id: deviceId,
      label,
      started_at: tsStart.toISOString(),
      ended_at: tsEnd.toISOString(),
      duration_seconds: totalDurationSec,
      turn_count: turnCount,
      sentiment_summary: sentiment?.summary,
      sentiment_score: sentiment?.score,
      notes: process.env.COCO_SESSION_NOTES,
    });
    return session;
  } finally {
    audioBinding.stop();
    session.close();
    if (historyListener) {
      try {
        session.off("history_added", historyListener);
      } catch {
        /* ignore */
      }
    }
  }
}
