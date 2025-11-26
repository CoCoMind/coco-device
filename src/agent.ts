import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import OpenAI from "openai";
import { Activity, buildPlan } from "./planner";
import { createSessionIdentifiers, sendSessionSummary } from "./backend";
import { tools } from "./tools";
import { ALSA_SAMPLE_RATE, createAlsaAudioBinding } from "./audioIO";

export const REALTIME_MODEL =
  process.env.REALTIME_MODEL ?? "gpt-4o-mini-realtime-preview-2024-12-17";
const TEXT_ONLY =
  (process.env.OPENAI_OUTPUT_MODALITY ?? "").toLowerCase() === "text" ||
  process.env.COCO_AUDIO_DISABLE === "1";

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
Do NOT say or read out any metadata (ids, categories, domains, durations). Keep spoken language natural and participant-facing only.
- Give feedback that matches the participant’s answer: praise only when correct/on-track; if incomplete or off, gently guide or correct with one clear hint.
- After the closing line, stop. Do not restart or begin a new session.
- Avoid blanket praise; if you are unsure whether the participant was correct, ask a brief clarifying follow-up instead of saying “great job.”
End with a single positive closing line.
Start immediately on connect (do not wait for the user to speak).`;

type SayOptions = {
  timeoutMs?: number;
};

const INTRO_RESPONSE_WINDOW_MS = Number(
  process.env.COCO_INTRO_RESPONSE_WINDOW_MS ?? "8000",
);
const MIN_LISTEN_WINDOW_MS = Number(
  process.env.COCO_MIN_LISTEN_WINDOW_MS ?? "12000",
);
const MAX_LISTEN_WINDOW_MS = Number(
  process.env.COCO_MAX_LISTEN_WINDOW_MS ?? "20000",
);
const FINAL_RESPONSE_WINDOW_MS = Number(
  process.env.COCO_FINAL_RESPONSE_WINDOW_MS ?? "8000",
);
const LISTEN_GRACE_MS = Number(
  process.env.COCO_LISTEN_GRACE_MS ?? "2000",
);

export type SentimentSnapshot = {
  summary: string;
  score: number;
};

export function parseSentimentJson(raw: string): SentimentSnapshot | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const stripped = trimmed
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as Partial<SentimentSnapshot>;
    if (
      parsed &&
      typeof parsed.summary === "string" &&
      typeof parsed.score === "number" &&
      Number.isFinite(parsed.score)
    ) {
      const clamped = Math.min(1, Math.max(0, parsed.score));
      return { summary: parsed.summary, score: clamped };
    }
  } catch {
    /* swallow parse errors; caller will warn */
  }
  return null;
}

export function extractTextFromMessage(item: any): string {
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
  const fullTranscript = utterances.join("\n");
  const transcript = fullTranscript.slice(0, 4000);
  if (fullTranscript.length > 4000) {
    console.warn(
      `[sentiment] Transcript truncated from ${fullTranscript.length} to 4000 chars for sentiment analysis`,
    );
  }
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
    const parsed = parseSentimentJson(raw);
    if (parsed) {
      return parsed;
    }
    console.warn("[sentiment] Unexpected sentiment response; raw output:", raw);
  } catch (error) {
    console.error("[sentiment] Failed to score sentiment:", error);
  }
  return null;
}

export function clampParticipantWindow(durationMin?: number) {
  const baseMin = Math.max(0.5, durationMin ?? 1);
  const derivedMs = Math.round(baseMin * 60_000);
  return Math.min(
    MAX_LISTEN_WINDOW_MS,
    Math.max(MIN_LISTEN_WINDOW_MS, derivedMs),
  );
}

type ResponseTracker = {
  waitForIdle: (timeoutMs?: number) => Promise<void>;
  cancelActive: () => void;
  trackResponse: (id: string) => void;
};

export function createResponseTracker(session: RealtimeSession): ResponseTracker {
  let active = 0;
  const trackedIds = new Set<string>();
  const waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const s = session as any;
  const clear = (event?: { response?: { id?: string } }) => {
    const id = event?.response?.id;
    if (id && trackedIds.has(id)) {
      trackedIds.delete(id);
      active = Math.max(0, active - 1);
    } else if (!id && active > 0) {
      active = Math.max(0, active - 1);
    }
    if (active === 0) {
      while (waiters.length) {
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      }
    }
  };
  s.on("response.done", clear);
  s.on("response.failed", clear);
  s.on("response.cancelled", clear);
  s.on("response.output_audio.done", clear);
  s.on("error", clear);

  async function waitForIdle(timeoutMs: number = 10_000) {
    if (active === 0) return;
    await new Promise<void>((resolve, reject) => {
      const onTimeout = () => {
        reject(
          new Error("Timed out waiting for previous response to finish"),
        );
      };
      const timer = setTimeout(onTimeout, timeoutMs);
      (timer as NodeJS.Timeout).unref?.();
      waiters.push({ resolve, reject, timer });
    });
  }

  const cancelActive = () => {
    if (active === 0) {
      return;
    }
    try {
      session.transport.sendEvent?.({ type: "response.cancel" });
    } catch (error) {
      console.warn("[realtime] failed to cancel active response:", error);
    }
  };

  const trackResponse = (id: string) => {
    if (!id) return;
    if (trackedIds.has(id)) return;
    trackedIds.add(id);
    active += 1;
  };

  return { waitForIdle, cancelActive, trackResponse };
}

function waitForAgentTurn(
  session: RealtimeSession,
  timeoutMs: number = 90000,
): Promise<void> {
  const s = session as any;
  return new Promise((resolve, reject) => {
    const expectsAudio = !TEXT_ONLY;
    let responseDone = false;
    let audioDone = !expectsAudio;

    const tryFinish = () => {
      if (responseDone && audioDone) {
        cleanup();
        console.info("[realtime] agent turn completed");
        resolve();
      }
    };
    const onResponseDone = () => {
      responseDone = true;
      tryFinish();
    };
    const onAudioDone = () => {
      audioDone = true;
      tryFinish();
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
      reject(new Error("Timed out waiting for agent response to finish"));
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    (timer as NodeJS.Timeout).unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      s.off?.("response.done", onResponseDone);
      s.off?.("response.failed", onError);
      s.off?.("response.cancelled", onError);
      s.off?.("error", onError);
      if (expectsAudio) {
        s.off?.("audio_done", onAudioDone);
        s.off?.("response.output_audio.done", onAudioDone);
      }
    };
    s.once?.("response.done", onResponseDone);
    s.once?.("response.failed", onError);
    s.once?.("response.cancelled", onError);
    if (expectsAudio) {
      s.once?.("audio_done", onAudioDone);
      s.once?.("response.output_audio.done", onAudioDone);
    }
    s.once?.("error", onError);
  });
}

async function sessionSay(
  session: RealtimeSession,
  tracker: ResponseTracker,
  text: string,
  options?: SayOptions,
) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  console.info("[realtime] prompting agent:", trimmed);

  const awaitResponse = (responseId: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      const s = session as any;
      const onDone = (event?: { response?: { id?: string } }) => {
        if (responseId && event?.response?.id && event.response.id !== responseId) {
          return;
        }
        cleanup();
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
        reject(normalized);
      };
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for response completion")),
        timeoutMs,
      );
      (timer as NodeJS.Timeout).unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        s.off?.("response.done", onDone);
        s.off?.("response.failed", onError);
        s.off?.("response.cancelled", onError);
        s.off?.("response.output_audio.done", onDone);
        s.off?.("error", onError);
      };
      s.once?.("response.done", onDone);
      s.once?.("response.failed", onError);
      s.once?.("response.cancelled", onError);
      s.once?.("response.output_audio.done", onDone);
      s.once?.("error", onError);
    });

  const waitForCreated = () => {
    const s = session as any;
    return new Promise<string>((resolve) => {
      const onCreated = (event?: { response?: { id?: string } }) => {
        const id = event?.response?.id;
        s.off?.("response.created", onCreated);
        resolve(id ?? "");
      };
      s.once?.("response.created", onCreated);
    });
  };

  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < 2) {
    await tracker.waitForIdle();
    tracker.cancelActive();
    // Register listener BEFORE sending event to avoid race condition
    const createdPromise = waitForCreated();
    await Promise.resolve(); // Ensure listener is attached before sending
    session.transport.sendEvent({
      type: "response.create",
      response: {
        instructions: [
          "Speak directly to the participant in a warm, upbeat tone. Keep it concise and supportive.",
          "Do not mention internal metadata (ids, categories, domains); only share natural, human-friendly wording.",
          "If you are repeating yourself because you did not hear the participant, briefly note that you are checking in, then pause.",
          "Do not enumerate or read any labels like 'category', 'domain', or 'activity id'.",
          "Give feedback that matches their answer; avoid saying 'great job' unless they were clearly correct/on-track. Offer a gentle hint or correction when needed.",
          "When the session is done, do not start another; end after the closing line.",
          "If unsure whether they were correct, ask a short follow-up instead of praising.",
          `Guidance: ${trimmed}`,
        ].join("\n"),
      },
    });
    try {
      const responseId = await createdPromise;
      tracker.trackResponse(responseId);
      await awaitResponse(responseId, options?.timeoutMs ?? 90000);
      return; // Success - exit function
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(String(error ?? "unknown"));
      console.warn("[realtime] response attempt failed, retrying once:", error);
      clearTransportAudioState(session);
      tracker.waitForIdle().catch(() => {});
      attempt += 1;
      // Exponential backoff: 300ms, 600ms, 1200ms...
      const backoffMs = 300 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
  }
  // All retries exhausted - throw error instead of silently continuing
  console.error("[realtime] Failed to deliver prompt after all retries");
  throw lastError ?? new Error("Failed to deliver prompt to agent");
}

async function waitForParticipantExchange(
  session: RealtimeSession,
  timeoutMs: number,
  graceMs: number = 0,
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
    let timer: NodeJS.Timeout | null = null;
    const startTimer = () => {
      timer = setTimeout(onTimeout, timeoutMs);
      (timer as NodeJS.Timeout).unref?.();
    };
    if (graceMs > 0) {
      setTimeout(startTimer, graceMs);
    } else {
      startTimer();
    }
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      session.off("history_added", onHistoryAdded);
    };
    session.on("history_added", onHistoryAdded);
    console.info(
      `[realtime] listening for participant (window=${timeoutMs}ms, grace=${graceMs}ms)`,
    );
  });
}

function clearTransportAudioState(session: RealtimeSession) {
  const transport = session.transport as {
    interrupt?: (cancelOngoingResponse?: boolean) => void;
  };
  if (typeof transport?.interrupt === "function") {
    try {
      transport.interrupt(true);
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
  async function handleNoInput(context: "intro" | "step") {
    const message =
      context === "intro"
        ? "I didn't hear you yet, but you can jump in at any time. Let's keep going."
        : "I didn't hear you that round, but I'll keep us moving. Feel free to chime in whenever you're ready.";
    await sessionSay(session, responseTracker, message);
    await waitForPlaybackIdle();
  }

  const agent = createAgent();
  const session = new RealtimeSession(agent, {
    model: REALTIME_MODEL,
    transport: "websocket",
    config: TEXT_ONLY
      ? { modalities: ["text"] }
      : {
          audio: {
            input: {
              format: { type: "audio/pcm", rate: ALSA_SAMPLE_RATE },
            },
            output: {
              format: { type: "audio/pcm", rate: ALSA_SAMPLE_RATE },
            },
          },
        },
  });
  const audioBinding = TEXT_ONLY
    ? { start() {}, stop() {}, waitForPlaybackIdle: async () => {} }
    : createAlsaAudioBinding(session);
  const waitForPlaybackIdle = async () => {
    await audioBinding.waitForPlaybackIdle?.();
  };
  const responseTracker = createResponseTracker(session);
  let historyListener: ((item: unknown) => void) | null = null;

  try {
    const participantUtterances: string[] = [];
    let stopRequested = false;
    historyListener = (item: unknown) => {
      const candidate = item as { type?: string; role?: string } | undefined;
      if (!candidate || candidate.type !== "message") {
        return;
      }
      const text = extractTextFromMessage(candidate);
      if (!text) return;
      if (candidate.role === "user") {
        participantUtterances.push(text);
        console.info(`[realtime] participant: ${text}`);
        const normalized = text.toLowerCase();
        if (
          normalized.includes("stop session") ||
          normalized.includes("end session") ||
          normalized === "stop" ||
          normalized.startsWith("stop ") ||
          normalized.startsWith("end ") ||
          normalized.includes("thank you") ||
          normalized.includes("thanks") ||
          normalized.includes("it's over") ||
          normalized.includes("its over") ||
          normalized.includes("that's all") ||
          normalized.includes("bye")
        ) {
          stopRequested = true;
        }
      } else if (candidate.role === "assistant") {
        console.info(`[realtime] agent said: ${text}`);
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
      responseTracker,
      "Let's begin. I'll guide you through a brief set of activities.",
    );
    await waitForPlaybackIdle();

    const heardIntro = await waitForParticipantExchange(
      session,
      INTRO_RESPONSE_WINDOW_MS,
      LISTEN_GRACE_MS,
    );
    if (!heardIntro) {
      await handleNoInput("intro");
    }
    if (stopRequested) {
      await sessionSay(
        session,
        responseTracker,
        "Okay, I'll stop here. Thank you for spending time with me today.",
      );
      await waitForPlaybackIdle();
      return session;
    }

    let turnCount = 0;

    for (const step of plan) {
      const line =
        step.prompt ?? step.instructions ?? (step.trials?.[0] ?? "");
      await sessionSay(session, responseTracker, line);
      await waitForPlaybackIdle();
      turnCount += 1;
      const listenWindowMs = clampParticipantWindow(step.duration_min);
      const participantResponded = await waitForParticipantExchange(
        session,
        listenWindowMs,
        LISTEN_GRACE_MS,
      );
      if (!participantResponded) {
        await handleNoInput("step");
      }
      if (stopRequested) {
        await sessionSay(
          session,
          responseTracker,
          "Got it. I'll wrap up here. Thank you for sharing your time.",
        );
        await waitForPlaybackIdle();
        break;
      }
      // (The agent’s default turn-taking now waits for the participant before advancing.)
      // telemetry tool call skipped in standalone runner

    }

    await sessionSay(
      session,
      responseTracker,
      "Great work today. Take a breath and enjoy the rest of your day.",
    );
    await waitForPlaybackIdle();
    await waitForParticipantExchange(session, FINAL_RESPONSE_WINDOW_MS);
    stopRequested = true;
    const tsEnd = new Date();
    const totalDurationSec = Math.round(
      (tsEnd.getTime() - tsStart.getTime()) / 1000
    );
    const sentiment =
      (await scoreSentimentFromTranscript(participantUtterances)) ?? {
        summary: "no_input",
        score: 0,
      };
    const fullTranscriptNote = participantUtterances
      .map((u, idx) => `${idx + 1}: ${u}`)
      .join(" | ");
    const transcriptNote = fullTranscriptNote.slice(0, 1800);
    if (fullTranscriptNote.length > 1800) {
      console.warn(
        `[backend] Session notes truncated from ${fullTranscriptNote.length} to 1800 chars`,
      );
    }
    const summaryPayload = {
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
      notes:
        process.env.COCO_SESSION_NOTES ??
        (transcriptNote ? `transcript: ${transcriptNote}` : undefined),
    };
    console.info("[backend] sending session summary", summaryPayload);
    await sendSessionSummary(summaryPayload);
    console.info("[backend] session summary sent");
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
