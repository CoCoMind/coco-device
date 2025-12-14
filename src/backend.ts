import { randomUUID } from "node:crypto";
import log from "./logger";

const BACKEND_URL = process.env.COCO_BACKEND_URL || undefined;
const INGEST_TOKEN =
  process.env.INGEST_SERVICE_TOKEN || process.env.COCO_BACKEND_API_KEY;
const BACKEND_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.COCO_BACKEND_TIMEOUT_MS ?? "10000") || 10000,
);
const BACKEND_RETRIES = Math.max(
  0,
  Number(process.env.COCO_BACKEND_RETRIES ?? "1") || 0,
);

export type SessionStatus = "success" | "unattended" | "early_exit" | "error_exit";

export type SessionSummaryPayload = {
  session_id: string;
  plan_id: string;
  user_external_id?: string;
  participant_id?: string;
  device_id?: string;
  label?: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  turn_count: number;
  status: SessionStatus;
  sentiment_summary?: string;
  sentiment_score?: number;
  notes?: string;
};

async function postJSON(
  baseUrl: string | undefined,
  path: string,
  body: unknown,
  label: string,
  token?: string
): Promise<boolean> {
  if (!baseUrl) {
    log.warn("backend", `Skipping ${label}; base URL not configured`);
    return false;
  }
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const url = new URL(path, baseUrl).toString();
  const attempts = Math.max(1, BACKEND_RETRIES + 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const startTime = Date.now();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(
          `POST ${label} timed out after ${BACKEND_TIMEOUT_MS}ms (attempt ${attempt}/${attempts})`,
        ),
      );
    }, BACKEND_TIMEOUT_MS);

    try {
      log.request("POST", url, body, attempt, attempts);

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const durationMs = Date.now() - startTime;
      let responseBody: unknown;
      try {
        responseBody = await res.text();
      } catch {
        responseBody = undefined;
      }

      if (!res.ok) {
        log.response("POST", url, res.status, durationMs, responseBody);
        throw new Error(`${res.status} ${res.statusText} ${responseBody ?? ""}`);
      }

      log.response("POST", url, res.status, durationMs);
      return true;
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const isLastAttempt = attempt === attempts;

      if (isLastAttempt) {
        log.error("backend", `POST ${label} FAILED after ${attempts} attempts (${durationMs}ms)`, error);
        return false;
      } else {
        log.warn("backend", `POST ${label} failed (attempt ${attempt}/${attempts}, ${durationMs}ms), retrying...`, error);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  return false;
}

export async function sendSessionSummary(payload: SessionSummaryPayload): Promise<boolean> {
  log.lifecycle("Sending session summary to backend", {
    session_id: payload.session_id,
    duration_seconds: payload.duration_seconds,
    turn_count: payload.turn_count,
    sentiment: payload.sentiment_summary,
  });

  const success = await postJSON(
    BACKEND_URL,
    "/internal/ingest/session_summary",
    payload,
    "session summary",
    INGEST_TOKEN
  );

  if (success) {
    log.lifecycle("Session summary send complete");
  } else {
    log.error("backend", "Session summary send FAILED - data may be lost");
  }
  return success;
}

export function createSessionIdentifiers() {
  const ids = {
    sessionId: randomUUID(),
    planId: randomUUID(),
  };
  log.debug("backend", "Created session identifiers", ids);
  return ids;
}

export type SessionStartFailedPayload = {
  device_id: string;
  participant_id?: string;
  user_external_id?: string;
  error_type: string;
  error_message: string;
  timestamp: string;
};

/**
 * Reports a session crash/error using the existing session_summary endpoint.
 * Creates a minimal session with status="error_exit" and error details in notes.
 */
export async function sendSessionStartFailed(payload: SessionStartFailedPayload): Promise<boolean> {
  log.lifecycle("Sending error session to backend", {
    device_id: payload.device_id,
    error_type: payload.error_type,
  });

  // Generate IDs for this error session
  const { sessionId, planId } = createSessionIdentifiers();

  // Use existing session_summary endpoint with error_exit status
  const summaryPayload: SessionSummaryPayload = {
    session_id: sessionId,
    plan_id: planId,
    device_id: payload.device_id,
    participant_id: payload.participant_id,
    user_external_id: payload.user_external_id ?? payload.participant_id,
    started_at: payload.timestamp,
    ended_at: payload.timestamp,
    duration_seconds: 0,
    turn_count: 0,
    status: "error_exit",
    sentiment_score: 0,
    notes: `${payload.error_type}: ${payload.error_message}`,
  };

  const success = await postJSON(
    BACKEND_URL,
    "/internal/ingest/session_summary",
    summaryPayload,
    "error session",
    INGEST_TOKEN
  );

  if (success) {
    log.lifecycle("Error session send complete");
  }
  return success;
}
