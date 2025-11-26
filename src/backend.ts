import { randomUUID } from "node:crypto";

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
) {
  if (!baseUrl) {
    console.warn(`[backend] Skipping ${label}; base URL not configured.`);
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
    const timer = setTimeout(() => {
      controller.abort(
        new Error(
          `POST ${label} timed out after ${BACKEND_TIMEOUT_MS}ms (attempt ${attempt}/${attempts})`,
        ),
      );
    }, BACKEND_TIMEOUT_MS);
    try {
      console.info(`[backend] POST ${label} → ${url} (attempt ${attempt}/${attempts})`);
      console.debug(`[backend] payload: ${payload}`);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} ${text}`);
      }
      console.info(`[backend] POST ${label} succeeded (${res.status})`);
      return;
    } catch (error) {
      clearTimeout(timer);
      const isLastAttempt = attempt === attempts;
      const level = isLastAttempt ? "error" : "warn";
      console[level as "warn" | "error"](
        `[backend] POST ${label} failed (attempt ${attempt}/${attempts}):`,
        error,
      );
      if (isLastAttempt) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

export async function sendSessionSummary(payload: SessionSummaryPayload) {
  await postJSON(
    BACKEND_URL,
    "/internal/ingest/session_summary",
    payload,
    "session summary",
    INGEST_TOKEN
  );
}

export function createSessionIdentifiers() {
  return {
    sessionId: randomUUID(),
    planId: randomUUID(),
  };
}
