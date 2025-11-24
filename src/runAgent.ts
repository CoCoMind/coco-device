import { REALTIME_MODEL, startSession } from "./agent";
import { runMockAgentSession } from "./mockAgent";

async function createEphemeralKey(): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY to mint a realtime session key.");
  }

  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        output_modalities:
          process.env.OPENAI_OUTPUT_MODALITY === "text"
            ? ["text"]
            : ["audio"],
        audio: {
          input: undefined,
          output: {
            voice: process.env.OPENAI_VOICE ?? "verse",
          },
        },
      },
    }),
  });

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
  const key = data.value ?? data.client_secret?.value;
  if (!key) {
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
    console.warn(
      `[runAgent] Unrecognized COCO_AGENT_MODE="${raw}", defaulting to mock.`,
    );
  }
  return "mock";
}

async function runRealtime() {
  const ephemeralKey =
    process.env.OPENAI_EPHEMERAL_KEY ?? (await createEphemeralKey());
  await startSession(ephemeralKey);
}

async function main() {
  const mode = resolveMode();
  console.log(`[runAgent] starting in ${mode} mode`);
  if (mode === "realtime") {
    await runRealtime();
  } else {
    await runMockAgentSession();
  }
}

main().catch((error) => {
  console.error("[runAgent] fatal:", error);
  process.exit(1);
});
