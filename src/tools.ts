import { tool } from "@openai/agents";
import { z } from "zod";
import { buildPlan } from "./planner";
import { logEvent } from "./telemetry";
import log from "./logger";

const telemetrySchema = z.object({
  activity_id: z.string(),
  category: z.string(),
  domain: z.string().optional(),
  duration_min: z.number().optional(),
  result: z.string().optional(),
  ms: z.number().optional(),
});

// Callback for end_session tool - set by agent.ts
let endSessionCallback: (() => void) | null = null;

export function setEndSessionCallback(callback: () => void) {
  endSessionCallback = callback;
}

export function clearEndSessionCallback() {
  endSessionCallback = null;
}

export const tools = [
  tool({
    name: "curriculum.build_plan",
    description: "Return a 6-step, ~10-minute plan following Coco rules.",
    parameters: z.object({}),
    strict: true,
    execute: async () => buildPlan(),
  }),
  tool({
    name: "telemetry.log",
    description: "Record step result/timing.",
    parameters: telemetrySchema,
    strict: true,
    execute: async (params: z.infer<typeof telemetrySchema>) => {
      await logEvent(params);
      return { ok: true };
    },
  }),
  tool({
    name: "end_session",
    description:
      "End the current coaching session gracefully. Call this tool when the participant says 'stop session', 'end session', 'goodbye', 'I'm done', 'that's all', 'stop', or any similar phrase indicating they want to end the session. Say a brief goodbye message BEFORE calling this tool.",
    parameters: z.object({
      reason: z.string().optional().describe("Optional reason for ending the session"),
    }),
    strict: true,
    execute: async (params: { reason?: string }) => {
      log.lifecycle("end_session tool called", { reason: params.reason ?? "none" });
      if (endSessionCallback) {
        endSessionCallback();
      }
      return { ok: true, message: "Session ending" };
    },
  }),
];
