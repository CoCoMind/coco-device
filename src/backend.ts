import { randomUUID } from "node:crypto";

const BACKEND_URL = process.env.COCO_BACKEND_URL || undefined;
const INGEST_TOKEN =
  process.env.INGEST_SERVICE_TOKEN || process.env.COCO_BACKEND_API_KEY;

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
  try {
    const url = new URL(path, baseUrl).toString();
    console.info(`[backend] POST ${label} → ${url}`);
    console.debug(`[backend] payload: ${payload}`);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} ${text}`);
    }
    console.info(`[backend] POST ${label} succeeded (${res.status})`);
  } catch (error) {
    console.error(`[backend] POST ${label} failed:`, error);
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
