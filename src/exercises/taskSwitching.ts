/**
 * Task Switching Exercise Handler
 *
 * Handles "Category Switcher" and "Rule Change Game".
 * Tests cognitive flexibility through alternating rules.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore, normalizeLatency, computeCompositeScore } from "../utils/scoring";

export interface TaskSwitchingContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  log: (msg: string) => void;
}

export async function runTaskSwitchingExercise(
  activity: Activity,
  ctx: TaskSwitchingContext
): Promise<ActivityResult> {
  const startTime = new Date();

  if (activity.id === "category_switcher") {
    return runCategorySwitcher(activity, ctx, startTime);
  } else if (activity.id === "rule_change_game") {
    return runRuleChangeGame(activity, ctx, startTime);
  }

  // Default to category switcher behavior
  return runCategorySwitcher(activity, ctx, startTime);
}

async function runCategorySwitcher(
  activity: Activity,
  ctx: TaskSwitchingContext,
  startTime: Date
): Promise<ActivityResult> {
  const transcripts: string[] = [];
  const latencies: number[] = [];
  let correct = 0;
  let total = 0;

  // Expected answers for the script
  const expectedAnswers: Array<{ type: "category" | "item"; answer: string[] }> = [
    { type: "category", answer: ["fruit", "food"] }, // Apple
    { type: "item", answer: [] }, // Give me an animal (any animal is correct)
    { type: "category", answer: ["tool", "hardware"] }, // Hammer
    { type: "item", answer: [] }, // Name a color
    { type: "category", answer: ["instrument", "music"] }, // Piano
    { type: "item", answer: [] }, // Type of weather
    { type: "category", answer: ["flower", "plant"] }, // Rose
    { type: "item", answer: [] }, // Name a vehicle
  ];

  ctx.log(`TaskSwitching: Running Category Switcher`);

  // Instructions
  await ctx.speak(activity.script[0]);

  // Process each prompt
  for (let i = 1; i < activity.script.length - 1; i++) {
    const prompt = activity.script[i];
    await ctx.speak(prompt);

    const response = await ctx.listen();
    transcripts.push(response.transcript);
    latencies.push(response.latency_ms);
    total++;

    const expected = expectedAnswers[i - 1];
    if (expected) {
      if (expected.type === "item") {
        // Any reasonable response is correct for "give me an X"
        if (response.transcript.trim().length > 0) {
          correct++;
        }
      } else {
        // Check if they named a correct category
        const responseLower = response.transcript.toLowerCase();
        if (expected.answer.some((a) => responseLower.includes(a))) {
          correct++;
        }
      }
    }

    ctx.log(
      `TaskSwitching: "${prompt}" -> "${response.transcript}" (${response.latency_ms}ms)`
    );
  }

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const avgLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : undefined;

  const accuracy = total > 0 ? (correct / total) * 100 : 0;
  const score = activity.scoring.capture_timing && avgLatency
    ? computeCompositeScore([
        { value: accuracy, weight: 2 },
        { value: normalizeLatency(avgLatency), weight: 1 },
      ])
    : Math.round(accuracy);

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: correct,
    response_time_ms: avgLatency,
    transcripts,
    turn_count: total,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

async function runRuleChangeGame(
  activity: Activity,
  ctx: TaskSwitchingContext,
  startTime: Date
): Promise<ActivityResult> {
  const transcripts: string[] = [];
  const latencies: number[] = [];

  // Stimuli and their sizes
  const stimuli = [
    { word: "Elephant", isBig: true },
    { word: "Ant", isBig: false },
    { word: "Mountain", isBig: true },
    { word: "Button", isBig: false },
    { word: "Ocean", isBig: true },
    // After switch
    { word: "House", isBig: true },
    { word: "Pea", isBig: false },
    { word: "Whale", isBig: true },
    { word: "Grain of sand", isBig: false },
    { word: "Tree", isBig: true },
    { word: "Seed", isBig: false },
  ];

  let preSwitch = { correct: 0, total: 0 };
  let postSwitch = { correct: 0, total: 0 };
  let ruleReversed = false;

  ctx.log(`TaskSwitching: Running Rule Change Game`);

  // Instructions
  await ctx.speak(activity.script[0]);

  for (let i = 1; i < activity.script.length - 1; i++) {
    const line = activity.script[i];

    // Check for rule switch
    if (line.includes("SWITCH")) {
      await ctx.speak(line);
      ruleReversed = true;
      continue;
    }

    // Present stimulus
    await ctx.speak(line);

    const response = await ctx.listen();
    transcripts.push(response.transcript);
    latencies.push(response.latency_ms);

    // Find the stimulus
    const stimulus = stimuli.find((s) =>
      line.toLowerCase().includes(s.word.toLowerCase())
    );

    if (stimulus) {
      const responseLower = response.transcript.toLowerCase();
      const saidBig = responseLower.includes("big");
      const saidSmall = responseLower.includes("small");

      let isCorrect: boolean;
      if (!ruleReversed) {
        // Normal rule: big for big, small for small
        isCorrect =
          (stimulus.isBig && saidBig) || (!stimulus.isBig && saidSmall);
        preSwitch.total++;
        if (isCorrect) preSwitch.correct++;
      } else {
        // Reversed rule: small for big, big for small
        isCorrect =
          (stimulus.isBig && saidSmall) || (!stimulus.isBig && saidBig);
        postSwitch.total++;
        if (isCorrect) postSwitch.correct++;
      }

      ctx.log(
        `TaskSwitching: "${stimulus.word}" (${stimulus.isBig ? "big" : "small"}) -> "${response.transcript}" = ${isCorrect ? "correct" : "wrong"}`
      );
    }
  }

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const totalCorrect = preSwitch.correct + postSwitch.correct;
  const totalTrials = preSwitch.total + postSwitch.total;

  const avgLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : undefined;

  const score = normalizeScore(
    totalCorrect,
    activity.scoring.normalization?.min_expected ?? 6,
    activity.scoring.normalization?.max_expected ?? totalTrials
  );

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: totalCorrect,
    response_time_ms: avgLatency,
    transcripts,
    turn_count: totalTrials,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}
