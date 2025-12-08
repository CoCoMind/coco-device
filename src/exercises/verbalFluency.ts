/**
 * Verbal Fluency Exercise Handler
 *
 * Handles "Letter Dash" (phonemic), "Category Sprint" (semantic),
 * and "Quick Connections" (word association) activities.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore, countUniqueWords, normalizeLatency } from "../utils/scoring";

export interface VerbalFluencyContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  listenForDuration: (
    seconds: number,
    encourageCallback?: () => Promise<void>
  ) => Promise<{ transcript: string; latency_ms: number }>;
  log: (msg: string) => void;
}

export async function runVerbalFluencyExercise(
  activity: Activity,
  ctx: VerbalFluencyContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];
  const latencies: number[] = [];

  const params = activity.difficulty_params ?? {};
  const timeLimit = params.time_limit_sec ?? 45;

  ctx.log(`VerbalFluency: Running ${activity.id} with ${timeLimit}s limit`);

  // Check if this is a timed fluency task or quick associations
  const isTimedFluency = activity.id === "letter_dash" || activity.id === "category_sprint";
  const isQuickConnections = activity.id === "quick_connections" || activity.id === "rapid_fire_questions";

  if (isTimedFluency) {
    return runTimedFluency(activity, ctx, timeLimit, startTime);
  } else if (isQuickConnections) {
    return runQuickAssociations(activity, ctx, startTime);
  } else {
    // Default to timed fluency
    return runTimedFluency(activity, ctx, timeLimit, startTime);
  }
}

async function runTimedFluency(
  activity: Activity,
  ctx: VerbalFluencyContext,
  timeLimit: number,
  startTime: Date
): Promise<ActivityResult> {
  const transcripts: string[] = [];

  // Instructions and start
  await ctx.speak(activity.script[0]); // "Letter Dash! Name as many..."

  // Listen for the duration
  let encouragementIndex = 1;
  const response = await ctx.listenForDuration(timeLimit, async () => {
    if (activity.script[encouragementIndex]) {
      await ctx.speak(activity.script[encouragementIndex]);
      encouragementIndex++;
    }
  });

  transcripts.push(response.transcript);

  // Count unique valid words
  const words = countUniqueWords(response.transcript);

  // For letter dash, filter by starting letter
  let validWords = words;
  const params = activity.difficulty_params ?? {};
  if (params.letter) {
    const letter = params.letter.toLowerCase();
    validWords = words.filter((w) => w.startsWith(letter));
  }

  ctx.log(`VerbalFluency: Got ${validWords.length} valid words`);

  // Closing
  const closingScript = activity.script[activity.script.length - 1];
  await ctx.speak(closingScript.replace("[X]", String(validWords.length)));

  const endTime = new Date();
  const score = normalizeScore(
    validWords.length,
    activity.scoring.normalization?.min_expected ?? 5,
    activity.scoring.normalization?.max_expected ?? 25
  );

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: validWords.length,
    transcripts,
    turn_count: 1,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

async function runQuickAssociations(
  activity: Activity,
  ctx: VerbalFluencyContext,
  startTime: Date
): Promise<ActivityResult> {
  const transcripts: string[] = [];
  const latencies: number[] = [];

  // Instructions
  await ctx.speak(activity.script[0]);

  // Process each prompt in the script (skip first instruction and last closing)
  for (let i = 1; i < activity.script.length - 1; i++) {
    const prompt = activity.script[i];
    await ctx.speak(prompt);

    const response = await ctx.listen();
    transcripts.push(response.transcript);
    latencies.push(response.latency_ms);

    ctx.log(
      `VerbalFluency: "${prompt}" -> "${response.transcript}" (${response.latency_ms}ms)`
    );
  }

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const avgLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 2000;

  // For quick connections, score is based on response speed
  const score = normalizeLatency(avgLatency);

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: avgLatency,
    response_time_ms: avgLatency,
    transcripts,
    turn_count: transcripts.length,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}
