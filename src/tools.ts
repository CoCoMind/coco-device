import { tool } from "@openai/agents";
import { z } from "zod";
import { buildPlan } from "./planner";
import { logEvent } from "./telemetry";

const telemetrySchema = z.object({
  activity_id: z.string(),
  category: z.string(),
  domain: z.string().optional(),
  duration_min: z.number().optional(),
  result: z.string().optional(),
  ms: z.number().optional(),
});

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
];
