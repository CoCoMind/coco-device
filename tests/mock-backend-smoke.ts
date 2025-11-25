/**
 * Minimal smoke test to verify sendSessionSummary posts to COCO_BACKEND_URL.
 */
import http from "node:http";
import { once } from "node:events";

async function main() {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const result = {
        path: req.url,
        method: req.method,
        authorization: req.headers["authorization"] ?? "",
        body,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      server.emit("captured", result);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  process.env.COCO_BACKEND_URL = `http://127.0.0.1:${address.port}`;
  process.env.INGEST_SERVICE_TOKEN = "test-token";
  const { sendSessionSummary } = await import("../src/backend");
  const capturedPromise = once(server, "captured");

  const payload = {
    session_id: "s1",
    plan_id: "p1",
    user_external_id: "u1",
    participant_id: "p1",
    device_id: "d1",
    label: "test",
    started_at: new Date(0).toISOString(),
    ended_at: new Date(1_000).toISOString(),
    duration_seconds: 1,
    turn_count: 1,
    sentiment_summary: "neutral",
    sentiment_score: 0,
  };

  await sendSessionSummary(payload);
  const [captured] = (await capturedPromise) as [
    {
      path?: string | null;
      method?: string | null;
      authorization?: string | string[];
      body: string;
    },
  ];
  server.close();

  if (!captured.path?.includes("/internal/ingest/session_summary")) {
    throw new Error(`Unexpected path: ${captured.path}`);
  }
  if (captured.method !== "POST") {
    throw new Error(`Unexpected method: ${captured.method}`);
  }
  if (captured.authorization !== "Bearer test-token") {
    throw new Error(`Missing bearer token: ${captured.authorization}`);
  }
  try {
    JSON.parse(captured.body);
  } catch (err) {
    throw new Error(`Body is not JSON: ${captured.body}`);
  }
  console.log("mock-backend-smoke: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
