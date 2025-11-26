import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import OpenAI from "openai";
import { Activity, buildPlan } from "./planner";
import { createSessionIdentifiers, sendSessionSummary } from "./backend";
import { tools, setEndSessionCallback, clearEndSessionCallback } from "./tools";
import { ALSA_SAMPLE_RATE, createAlsaAudioBinding } from "./audioIO";
import log from "./logger";

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
- If user says "skip" or seems tired, shorten remaining steps.
Do NOT say or read out any metadata (ids, categories, domains, durations). Keep spoken language natural and participant-facing only.
- Give feedback that matches the participant's answer: praise only when correct/on-track; if incomplete or off, gently guide or correct with one clear hint.
- After the closing line, stop. Do not restart or begin a new session.
- Avoid blanket praise; if you are unsure whether the participant was correct, ask a brief clarifying follow-up instead of saying "great job."
End with a single positive closing line.
Start immediately on connect (do not wait for the user to speak).

IMPORTANT: If the participant says "stop session", "end session", "goodbye", "I'm done", "that's all", "stop", or any similar phrase indicating they want to end early:
1. Say a brief, warm goodbye (e.g., "Thanks for spending time with me today. Take care!")
2. Then call the end_session tool to close the session gracefully.`;

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
    log.debug("sentiment", "No utterances to analyze");
    return null;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn("sentiment", "OPENAI_API_KEY missing; skipping sentiment scoring");
    return null;
  }
  const client = new OpenAI({ apiKey });
  const fullTranscript = utterances.join("\n");
  const transcript = fullTranscript.slice(0, 4000);
  if (fullTranscript.length > 4000) {
    log.warn("sentiment", `Transcript truncated from ${fullTranscript.length} to 4000 chars`);
  }
  try {
    log.debug("sentiment", `Analyzing ${utterances.length} utterances (${transcript.length} chars)`);
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
      log.info("sentiment", `Analysis complete: ${parsed.summary} (score: ${parsed.score})`);
      return parsed;
    }
    log.warn("sentiment", "Unexpected sentiment response", { raw });
  } catch (error) {
    log.error("sentiment", "Failed to score sentiment", error);
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
      log.debug("tracker", `Response ${id} completed, active=${active}`);
    } else if (!id && active > 0) {
      active = Math.max(0, active - 1);
      log.debug("tracker", `Response cleared (no id), active=${active}`);
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
      log.debug("tracker", "Cancelling active response");
      session.transport.sendEvent?.({ type: "response.cancel" });
    } catch (error) {
      log.warn("tracker", "Failed to cancel active response", error);
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
        log.debug("agent", "Agent turn completed");
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
      log.error("agent", "Session error", normalized);
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
  log.session(`Agent prompt: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}"`);

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
    log.debug("agent", "Sending response.create event");
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
    log.debug("agent", "response.create event sent");
    try {
      const responseId = await createdPromise;
      tracker.trackResponse(responseId);
      await awaitResponse(responseId, options?.timeoutMs ?? 90000);
      return; // Success - exit function
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(String(error ?? "unknown"));
      log.warn("agent", `Response attempt ${attempt} failed, retrying...`, error);
      clearTransportAudioState(session);
      tracker.waitForIdle().catch(() => {});
      attempt += 1;
      // Exponential backoff: 300ms, 600ms, 1200ms...
      const backoffMs = 300 * Math.pow(2, attempt - 1);
      log.debug("agent", `Backoff ${backoffMs}ms before retry`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
  }
  // All retries exhausted - throw error instead of silently continuing
  log.error("agent", "Failed to deliver prompt after all retries");
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
  log.session(`👂 Listening for participant (window=${timeoutMs}ms, grace=${graceMs}ms)`);

  return new Promise<boolean>((resolve) => {
    const onHistoryAdded = (item: unknown) => {
      const candidate = item as { type?: string; role?: string } | undefined;
      log.debug("listen", `history_added event: ${JSON.stringify(candidate)?.slice(0, 200)}`);
      if (!candidate || candidate.type !== "message" || candidate.role !== "user") {
        return;
      }
      log.session("✓ Participant message detected, resolving listen window");
      cleanup();
      resolve(true);
    };
    const onTimeout = () => {
      cleanup();
      log.warn("listen", `⏰ No participant response within ${timeoutMs}ms; continuing to next step`);
      resolve(false);
    };
    let timer: NodeJS.Timeout | null = null;
    const startTimer = () => {
      log.debug("listen", `Timer started (${timeoutMs}ms)`);
      timer = setTimeout(onTimeout, timeoutMs);
      (timer as NodeJS.Timeout).unref?.();
    };
    if (graceMs > 0) {
      log.debug("listen", `Grace period ${graceMs}ms before timer starts`);
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
      log.debug("realtime", "transport interrupt noop", error);
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
  log.lifecycle("SESSION START", { model: REALTIME_MODEL, textOnly: TEXT_ONLY });

  async function handleNoInput(context: "intro" | "step") {
    log.session(`No input detected (${context}), providing encouragement`);
    const message =
      context === "intro"
        ? "I didn't hear you yet, but you can jump in at any time. Let's keep going."
        : "I didn't hear you that round, but I'll keep us moving. Feel free to chime in whenever you're ready.";
    await sessionSay(session, responseTracker, message);
    await waitForPlaybackIdle();
  }

  log.debug("agent", "Creating RealtimeSession");
  const agent = createAgent();
  const session = new RealtimeSession(agent, {
    model: REALTIME_MODEL,
    transport: "websocket",
    config: TEXT_ONLY
      ? { modalities: ["text"] }
      : {
          modalities: ["audio"],
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
    ? { start() {}, stop() {}, stopCapture() {}, waitForPlaybackIdle: async () => {} }
    : createAlsaAudioBinding(session);
  const waitForPlaybackIdle = async () => {
    await audioBinding.waitForPlaybackIdle?.();
  };
  const responseTracker = createResponseTracker(session);
  let historyListener: ((item: unknown) => void) | null = null;

  try {
    const participantUtterances: string[] = [];
    let stopRequested = false;

    // Register the end_session tool callback
    setEndSessionCallback(() => {
      log.lifecycle("🛑 end_session tool called - stopping session");
      stopRequested = true;
      audioBinding.stopCapture();
    });

    historyListener = (item: unknown) => {
      const candidate = item as { type?: string; role?: string } | undefined;
      if (!candidate || candidate.type !== "message") {
        return;
      }
      const text = extractTextFromMessage(candidate);
      if (!text) return;
      if (candidate.role === "user") {
        participantUtterances.push(text);
        log.speech(`Participant: "${text}"`);
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
          log.lifecycle("🛑 STOP REQUESTED by participant", { text });
          stopRequested = true;
          // Interrupt any ongoing response (official API)
          session.interrupt();
          // Cancel tracked responses
          responseTracker.cancelActive();
          // IMMEDIATELY stop capture so no more audio goes to API
          audioBinding.stopCapture();
          log.lifecycle("Audio capture killed immediately");
        }
      } else if (candidate.role === "assistant") {
        log.speech(`Agent: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
      }
    };

    // Connect to Realtime (WebRTC in browser, WS in Node)
    log.lifecycle("Connecting to OpenAI Realtime API...");
    await session.connect({ apiKey: ephemeralKey });
    log.lifecycle("✓ Connected to OpenAI Realtime API");

    // Log tools registered with the agent
    log.info("agent", `Agent tools: ${tools.map(t => t.name).join(", ")}`);

    // Debug session events
    const s = session as any;
    s.on?.("session.updated", (event: unknown) => {
      log.info("realtime", "session.updated received", event);
    });
    s.on?.("session.created", (event: unknown) => {
      log.info("realtime", "session.created received - checking transcription settings", event);
    });

    log.debug("audio", "Starting audio binding");
    audioBinding.start();

    // Attach history listener for stop detection
    if (historyListener) {
      session.on("history_added", historyListener);
      log.lifecycle("historyListener attached for stop detection");
    } else {
      log.error("agent", "historyListener is null - stop detection will NOT work!");
    }

    // Debug logging for ALL session events
    // (reuse `s` from earlier)

    // Log ALL history_added events
    session.on("history_added", (item: unknown) => {
      log.info("realtime", `[EVENT] history_added: ${JSON.stringify(item)?.slice(0, 300)}`);
    });
    s.on?.("input_audio_buffer.speech_started", () => {
      log.speech("Speech started - participant is speaking");
    });
    s.on?.("input_audio_buffer.speech_stopped", () => {
      log.speech("Speech stopped - processing audio");
    });
    s.on?.("input_audio_buffer.committed", () => {
      log.debug("audio", "Audio buffer committed");
    });
    s.on?.("conversation.item.created", (event: unknown) => {
      const e = event as { item?: { type?: string; role?: string } } | undefined;
      log.debug("realtime", `conversation.item.created: type=${e?.item?.type}, role=${e?.item?.role}`);
    });
    s.on?.("conversation.item.input_audio_transcription.completed", (event: unknown) => {
      const e = event as { transcript?: string } | undefined;
      log.speech(`Transcription completed: "${e?.transcript?.slice(0, 100)}"`);
    });
    s.on?.("conversation.item.input_audio_transcription.failed", (event: unknown) => {
      log.error("realtime", "Transcription failed", event);
    });
    s.on?.("response.created", (event: unknown) => {
      const e = event as { response?: { id?: string } } | undefined;
      log.debug("realtime", `response.created: id=${e?.response?.id}`);
    });
    s.on?.("response.done", (event: unknown) => {
      log.debug("realtime", "response.done event received");
    });
    s.on?.("response.audio.delta", () => {
      log.debug("realtime", "response.audio.delta - audio chunk received");
    });
    s.on?.("error", (event: unknown) => {
      log.error("realtime", "Session error event", event);
    });
    s.on?.("response.function_call_arguments.done", (event: unknown) => {
      log.info("realtime", "Tool call arguments done!", event);
    });
    s.on?.("response.function_call_arguments.delta", (event: unknown) => {
      log.debug("realtime", "Tool call arguments delta", event);
    });
    // Listen for function_call items in conversation
    s.on?.("tool_call", (event: unknown) => {
      log.info("realtime", "🔧 TOOL CALL EVENT!", JSON.stringify(event)?.slice(0, 500));
    });
    s.on?.("tool_approved", (event: unknown) => {
      log.info("realtime", "🔧 Tool approved", event);
    });
    s.on?.("tool_start", (event: unknown) => {
      log.info("realtime", "🔧 Tool start", event);
    });
    s.on?.("tool_end", (event: unknown) => {
      log.info("realtime", "🔧 Tool end", event);
    });

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
      log.warn("config", `COCO_PARTICIPANT_ID/COCO_USER_EXTERNAL_ID not set; defaulting to "${userExternalId}"`);
    }
    const deviceId =
      process.env.COCO_DEVICE_ID ?? process.env.HOSTNAME ?? "local-device";
    if (!process.env.COCO_DEVICE_ID) {
      log.warn("config", `COCO_DEVICE_ID not set; defaulting to "${deviceId}"`);
    }
    const label =
      process.env.COCO_SESSION_LABEL ?? "coco-realtime-autostart-session";

    log.lifecycle("Session initialized", {
      sessionId,
      planId,
      deviceId,
      participantId,
      activityCount: plan.length,
    });

    // 2) Ask the agent to run it step-by-step with voice output
    log.session("=== INTRO PHASE ===");
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
      log.lifecycle("Session ending early (stop requested in intro)");
      await sessionSay(
        session,
        responseTracker,
        "Okay, I'll stop here. Thank you for spending time with me today.",
      );
      await waitForPlaybackIdle();
      log.lifecycle("SESSION END (early stop)");
      return session;
    }

    let turnCount = 0;

    log.session("=== ACTIVITIES PHASE ===");
    let saidGoodbye = false;
    for (let i = 0; i < plan.length; i++) {
      // Check at start of each iteration for early exit
      if (stopRequested) {
        log.lifecycle(`Stop already requested, skipping remaining activities`);
        if (!saidGoodbye) {
          await sessionSay(
            session,
            responseTracker,
            "Got it. I'll wrap up here. Thank you for sharing your time.",
          );
          await waitForPlaybackIdle();
          saidGoodbye = true;
        }
        break;
      }

      const step = plan[i];
      log.session(`--- Activity ${i + 1}/${plan.length}: ${step.category ?? "unknown"} ---`);

      // Check before starting activity
      if (stopRequested) {
        log.lifecycle(`Stop already set before activity ${i + 1}, breaking`);
        break;
      }

      const line =
        step.prompt ?? step.instructions ?? (step.trials?.[0] ?? "");
      await sessionSay(session, responseTracker, line);

      // Check after agent speaks
      if (stopRequested) {
        log.lifecycle(`Stop detected after agent spoke at activity ${i + 1}`);
        break;
      }

      await waitForPlaybackIdle();
      turnCount += 1;
      const listenWindowMs = clampParticipantWindow(step.duration_min);
      const participantResponded = await waitForParticipantExchange(
        session,
        listenWindowMs,
        LISTEN_GRACE_MS,
      );

      // Check stopRequested IMMEDIATELY after listen window
      if (stopRequested) {
        log.lifecycle(`Stop detected after listen window at activity ${i + 1}`);
        if (!saidGoodbye) {
          await sessionSay(
            session,
            responseTracker,
            "Got it. I'll wrap up here. Thank you for sharing your time.",
          );
          await waitForPlaybackIdle();
          saidGoodbye = true;
        }
        break;
      }

      if (!participantResponded) {
        await handleNoInput("step");
      }

      // Check again after handleNoInput
      if (stopRequested) {
        log.lifecycle(`Session ending early (stop requested at activity ${i + 1})`);
        if (!saidGoodbye) {
          await sessionSay(
            session,
            responseTracker,
            "Got it. I'll wrap up here. Thank you for sharing your time.",
          );
          await waitForPlaybackIdle();
          saidGoodbye = true;
        }
        break;
      }
    }

    // Handle closing
    log.session("=== CLOSING PHASE ===");

    // Stop capture FIRST so no more user speech is sent during goodbye
    log.lifecycle("Stopping audio capture before goodbye");
    audioBinding.stopCapture();

    // Say appropriate goodbye based on whether stop was requested
    if (stopRequested && !saidGoodbye) {
      log.lifecycle("Saying goodbye (stop was requested)");
      await sessionSay(
        session,
        responseTracker,
        "Got it. I'll wrap up here. Thank you for sharing your time.",
      );
      await waitForPlaybackIdle();
      saidGoodbye = true;
    } else if (!stopRequested) {
      await sessionSay(
        session,
        responseTracker,
        "Great work today. Take a breath and enjoy the rest of your day.",
      );
      await waitForPlaybackIdle();
    } else {
      log.debug("session", "Goodbye already said, skipping");
    }

    // Now stop everything and disconnect
    log.lifecycle("Stopping playback and disconnecting session");
    audioBinding.stop();

    // Interrupt any ongoing response and close (official API)
    session.interrupt();
    session.close();

    // Wait a bit for cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
    log.lifecycle("Session disconnected");

    stopRequested = true;
    const tsEnd = new Date();
    const totalDurationSec = Math.round(
      (tsEnd.getTime() - tsStart.getTime()) / 1000
    );

    log.lifecycle("Session activities complete", {
      durationSec: totalDurationSec,
      turnCount,
      utteranceCount: participantUtterances.length,
    });

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
      log.warn("backend", `Session notes truncated from ${fullTranscriptNote.length} to 1800 chars`);
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

    log.session("=== SUMMARY PHASE ===");
    await sendSessionSummary(summaryPayload);

    log.lifecycle("SESSION END", {
      sessionId,
      durationSec: totalDurationSec,
      turnCount,
      sentiment: sentiment?.summary,
    });

    return session;
  } finally {
    log.debug("cleanup", "Stopping audio binding and closing session");
    audioBinding.stop();

    // Clear the end_session callback
    clearEndSessionCallback();

    // Remove event listeners first
    if (historyListener) {
      try {
        session.off("history_added", historyListener);
      } catch {
        /* ignore */
      }
    }

    // Interrupt and close (official API)
    try {
      session.interrupt();
      session.close();
    } catch {
      /* ignore close errors */
    }

    log.debug("cleanup", "Session cleanup complete");
  }
}
