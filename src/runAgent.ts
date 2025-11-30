import { REALTIME_MODEL, startSession, SessionResult } from "./agent";
import { runMockAgentSession } from "./mockAgent";
import { sendSessionStartFailed } from "./backend";
import log, { toLocalISO } from "./logger";

function isTextOnlyMode(): boolean {
  const modality = (process.env.OPENAI_OUTPUT_MODALITY ?? "").toLowerCase();
  return modality === "text" || process.env.COCO_AUDIO_DISABLE === "1";
}

async function createEphemeralKey(): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY to mint a realtime session key.");
  }

  const abortAfterMs = Number(
    process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS ?? "15000",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("ephemeral key request timed out"));
  }, Math.max(1000, abortAfterMs));

  const sessionConfig = {
    type: "realtime",
    model: REALTIME_MODEL,
    output_modalities: isTextOnlyMode() ? ["text"] : ["audio"],
    audio: isTextOnlyMode()
      ? undefined
      : {
          input: undefined,
          output: {
            voice: process.env.OPENAI_VOICE ?? "verse",
          },
        },
  };
  log.info("runAgent", "Creating session with config", sessionConfig);

  const res = await fetch(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: sessionConfig }),
      signal: controller.signal,
    },
  ).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Failed to create realtime session (status ${res.status}): ${errText}`,
    );
  }

  const data = (await res.json()) as {
    value?: string;
    client_secret?: { value?: string };
  };
  log.debug("runAgent", "Session created", { responseKeys: Object.keys(data) });
  const key = data.value ?? data.client_secret?.value;
  if (!key) {
    log.error("runAgent", "Session response missing client_secret.value", data);
    throw new Error("Realtime session response missing client_secret.value");
  }
  return key;
}

type AgentMode = "realtime" | "mock";

function resolveMode(): AgentMode {
  const raw = (process.env.COCO_AGENT_MODE ?? "mock").toLowerCase();
  if (raw === "realtime") {
    return "realtime";
  }
  if (raw !== "mock") {
    log.warn("runAgent", `Unrecognized COCO_AGENT_MODE="${raw}", defaulting to mock`);
  }
  return "mock";
}

async function runRealtime() {
  const deviceId = process.env.COCO_DEVICE_ID ?? process.env.HOSTNAME ?? "unknown-device";
  const participantId = process.env.COCO_PARTICIPANT_ID;

  // Try to get ephemeral key with retry
  let ephemeralKey: string;
  const maxKeyRetries = 3;
  for (let attempt = 1; attempt <= maxKeyRetries; attempt++) {
    try {
      ephemeralKey = process.env.OPENAI_EPHEMERAL_KEY ?? (await createEphemeralKey());
      break;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("runAgent", `Ephemeral key fetch failed (attempt ${attempt}/${maxKeyRetries})`, error);

      if (attempt === maxKeyRetries) {
        // Send session_start_failed event to backend
        await sendSessionStartFailed({
          device_id: deviceId,
          participant_id: participantId,
          error_type: "ephemeral_key_fetch_failed",
          error_message: errorMessage.slice(0, 500),
          timestamp: toLocalISO(new Date()),
        }).catch((e) => log.error("runAgent", "Failed to send session_start_failed", e));

        log.error("runAgent", "All ephemeral key fetch attempts failed, exiting");
        process.exit(1);
      }

      // Wait before retry (exponential backoff)
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      log.info("runAgent", `Retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  // Set up forced exit timeout as a safety net (5 seconds after session should complete)
  const maxSessionMs = Number(process.env.COCO_MAX_SESSION_MS ?? "900000"); // 15 minutes default
  const forceExitTimer = setTimeout(() => {
    log.warn("runAgent", `Force exit triggered after ${maxSessionMs}ms - session may have hung`);
    process.exit(1);
  }, maxSessionMs);
  forceExitTimer.unref?.();

  let result: SessionResult | undefined;
  try {
    result = await startSession(ephemeralKey!);
    log.lifecycle("Session complete, exiting cleanly");
  } catch (error) {
    log.error("runAgent", "Session failed with error", error);

    // Send session_start_failed for connection errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("connect") || errorMessage.includes("WebSocket")) {
      await sendSessionStartFailed({
        device_id: deviceId,
        participant_id: participantId,
        error_type: "session_connection_failed",
        error_message: errorMessage.slice(0, 500),
        timestamp: toLocalISO(new Date()),
      }).catch((e) => log.error("runAgent", "Failed to send session_start_failed", e));
    }
  } finally {
    clearTimeout(forceExitTimer);
  }

  // Give a moment for cleanup, then force exit
  // Exit code 2 = unattended (no user input detected)
  // Exit code 0 = success (user participated)
  const exitCode = result && result.utteranceCount === 0 ? 2 : 0;
  if (exitCode === 2) {
    log.lifecycle("Session was unattended (no user input), exiting with code 2");
  }
  setTimeout(() => {
    log.lifecycle("Forcing exit after cleanup delay");
    process.exit(exitCode);
  }, 500).unref?.();
}

async function main() {
  const mode = resolveMode();
  log.lifecycle(`Starting in ${mode} mode`);
  if (mode === "realtime") {
    await runRealtime();
  } else {
    await runMockAgentSession();
  }
}

main().catch((error) => {
  log.error("runAgent", "Fatal error", error);
  process.exit(1);
});
