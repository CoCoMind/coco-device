import { randomUUID } from "node:crypto";
import log from "./logger";
import { ActivityResult, CognitiveDomain } from "./types/activity";

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

/**
 * Activity-level result for backend ingestion
 */
export type ActivityResultPayload = {
  activity_id: string;
  cognitive_domain: CognitiveDomain;
  score: number;
  raw_score?: number;
  response_time_ms?: number;
  difficulty_used: string;
  completed: boolean;
  turn_count: number;
  duration_sec: number;
};

/**
 * Domain score summary for backend ingestion
 */
export type DomainScorePayload = {
  domain: CognitiveDomain;
  score: number;
};

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
  // New fields for cognitive training results
  activity_results?: ActivityResultPayload[];
  domain_scores?: DomainScorePayload[];
  processing_speed_avg_ms?: number;
};

async function postJSON(
  baseUrl: string | undefined,
  path: string,
  body: unknown,
  label: string,
  token?: string
) {
  if (!baseUrl) {
    log.warn("backend", `Skipping ${label}; base URL not configured`);
    return;
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
      return;
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const isLastAttempt = attempt === attempts;

      if (isLastAttempt) {
        log.error("backend", `POST ${label} FAILED after ${attempts} attempts (${durationMs}ms)`, error);
      } else {
        log.warn("backend", `POST ${label} failed (attempt ${attempt}/${attempts}, ${durationMs}ms), retrying...`, error);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
}

/**
 * Converts ActivityResult to ActivityResultPayload for backend ingestion
 */
export function toActivityResultPayload(result: ActivityResult): ActivityResultPayload {
  return {
    activity_id: result.activity_id,
    cognitive_domain: result.cognitive_domain,
    score: result.score,
    raw_score: result.raw_score,
    response_time_ms: result.response_time_ms,
    difficulty_used: result.difficulty_used,
    completed: result.completed,
    turn_count: result.turn_count,
    duration_sec: result.duration_sec,
  };
}

export async function sendSessionSummary(payload: SessionSummaryPayload) {
  log.lifecycle("Sending session summary to backend", {
    session_id: payload.session_id,
    duration_seconds: payload.duration_seconds,
    turn_count: payload.turn_count,
    sentiment: payload.sentiment_summary,
    activity_count: payload.activity_results?.length ?? 0,
    domain_count: payload.domain_scores?.length ?? 0,
  });

  await postJSON(
    BACKEND_URL,
    "/internal/ingest/session_summary",
    payload,
    "session summary",
    INGEST_TOKEN
  );

  log.lifecycle("Session summary send complete");
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
  error_type: string;
  error_message: string;
  timestamp: string;
};

export async function sendSessionStartFailed(payload: SessionStartFailedPayload) {
  log.lifecycle("Sending session_start_failed to backend", {
    device_id: payload.device_id,
    error_type: payload.error_type,
  });

  await postJSON(
    BACKEND_URL,
    "/internal/ingest/session_start_failed",
    payload,
    "session_start_failed",
    INGEST_TOKEN
  );

  log.lifecycle("session_start_failed send complete");
}
