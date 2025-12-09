/**
 * Story Recall Exercise Handler
 *
 * Handles "Story Journey" - listen to a story and recall key details.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore } from "../utils/scoring";

export interface StoryRecallContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  log: (msg: string) => void;
}

export async function runStoryRecallExercise(
  activity: Activity,
  ctx: StoryRecallContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];

  const params = activity.difficulty_params ?? {};
  const detailCount = params.detail_count ?? 5;

  ctx.log(`StoryRecall: Running with ${detailCount} details to recall`);

  // Expected answers for the story in the script
  const expectedAnswers = [
    { question: "day", answers: ["tuesday"] },
    { question: "name", answers: ["peter"] },
    { question: "street", answers: ["maple", "maple street"] },
    { question: "croissants", answers: ["3", "three"] },
    { question: "dog", answers: ["max"] },
  ];

  let correct = 0;

  // Instructions
  await ctx.speak(activity.script[0]);

  // Tell the story
  await ctx.speak(activity.script[1]);

  // Ask each question
  for (let i = 2; i < activity.script.length - 1; i++) {
    const question = activity.script[i];
    await ctx.speak(question);

    const response = await ctx.listen();
    transcripts.push(response.transcript);

    // Check answer
    const expectedIndex = i - 2;
    if (expectedIndex < expectedAnswers.length) {
      const expected = expectedAnswers[expectedIndex];
      const responseLower = response.transcript.toLowerCase();

      const isCorrect = expected.answers.some((a) =>
        responseLower.includes(a.toLowerCase())
      );

      if (isCorrect) {
        correct++;
      }

      ctx.log(
        `StoryRecall: "${question}" -> "${response.transcript}" = ${isCorrect ? "correct" : "wrong"}`
      );
    }
  }

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const score = normalizeScore(
    correct,
    activity.scoring.normalization?.min_expected ?? 2,
    activity.scoring.normalization?.max_expected ?? detailCount
  );

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: correct,
    transcripts,
    turn_count: transcripts.length,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}
