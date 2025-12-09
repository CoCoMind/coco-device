/**
 * Digit Span Exercise Handler
 *
 * Handles "Number Echo" (forward) and "Backwards Challenge" (backward) activities.
 * Adaptive difficulty: increases span on success, stops after 2 failures.
 */

import { Activity, ActivityResult } from "../types/activity";
import {
  generateDigitSequence,
  compareDigitSequences,
  normalizeDigitSpan,
} from "../utils/scoring";

export interface DigitSpanContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  log: (msg: string) => void;
}

export async function runDigitSpanExercise(
  activity: Activity,
  ctx: DigitSpanContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];
  const latencies: number[] = [];

  const params = activity.difficulty_params ?? {};
  const direction = params.direction ?? "forward";
  let currentLength = params.sequence_length ?? (direction === "forward" ? 3 : 2);
  const maxLength = direction === "forward" ? 9 : 8;

  let consecutiveFailures = 0;
  let maxSpan = 0;
  let turnCount = 0;

  ctx.log(`DigitSpan: Starting ${direction} span, initial length ${currentLength}`);

  // Instructions
  await ctx.speak(activity.script[0]);

  while (currentLength <= maxLength && consecutiveFailures < 2) {
    // Generate and present sequence
    const digits = generateDigitSequence(currentLength);
    const digitsStr = digits.join(" ... ");

    await ctx.speak(`Here are your numbers: ${digitsStr}`);

    // Listen for response
    const response = await ctx.listen();
    transcripts.push(response.transcript);
    latencies.push(response.latency_ms);
    turnCount++;

    ctx.log(
      `DigitSpan: Got "${response.transcript}" for [${digits.join(",")}] (${direction})`
    );

    // Score response
    const isCorrect = compareDigitSequences(
      response.transcript,
      digits,
      direction
    );

    if (isCorrect) {
      maxSpan = currentLength;
      consecutiveFailures = 0;
      currentLength++;

      if (currentLength <= maxLength) {
        await ctx.speak("Perfect! Let's try a longer one.");
      }
    } else {
      consecutiveFailures++;
      if (consecutiveFailures < 2) {
        await ctx.speak("Let's try that length again.");
      }
    }
  }

  // Closing
  const closingMsg =
    maxSpan > 0
      ? `Great effort! You remembered sequences of ${maxSpan} numbers.`
      : "Good try! This one is tricky.";
  await ctx.speak(closingMsg);

  const endTime = new Date();
  const avgLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : undefined;

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score: normalizeDigitSpan(maxSpan),
    raw_score: maxSpan,
    response_time_ms: avgLatency,
    transcripts,
    turn_count: turnCount,
    difficulty_used: activity.difficulty === "adaptive" ? "medium" : activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}
