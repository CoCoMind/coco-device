/**
 * Instruction Following Exercise Handler
 *
 * Handles "Follow the Path" - multi-step instruction following.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore } from "../utils/scoring";

export interface InstructionFollowingContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  log: (msg: string) => void;
}

export async function runInstructionFollowingExercise(
  activity: Activity,
  ctx: InstructionFollowingContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];

  const params = activity.difficulty_params ?? {};
  const stepCount = params.step_count ?? 3;

  ctx.log(`InstructionFollowing: Running with ${stepCount} steps`);

  // Instructions
  await ctx.speak(activity.script[0]); // "Follow the Path! I'll give you three things..."

  // Present the instructions
  await ctx.speak(activity.script[1]); // "First, touch your nose. Second, clap twice..."

  // Say "Go!"
  await ctx.speak(activity.script[2]); // "Ready? Go!"

  // Listen for their response
  const response = await ctx.listen();
  transcripts.push(response.transcript);

  // Analyze their response for completed steps
  const completedSteps = analyzeInstructionCompletion(
    response.transcript,
    activity.script[1]
  );

  ctx.log(
    `InstructionFollowing: Completed ${completedSteps}/${stepCount} steps`
  );

  // Closing
  await ctx.speak(activity.script[3]); // "Perfect sequence!"

  const endTime = new Date();
  const score = normalizeScore(
    completedSteps,
    activity.scoring.normalization?.min_expected ?? 1,
    activity.scoring.normalization?.max_expected ?? stepCount
  );

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: completedSteps,
    transcripts,
    turn_count: 1,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

function analyzeInstructionCompletion(
  transcript: string,
  instructions: string
): number {
  const lower = transcript.toLowerCase();

  // For "Follow the Path" with nose, clap, color instructions
  let completed = 0;

  // Check for nose mention (they might say "touched my nose" or just describe it)
  if (
    lower.includes("nose") ||
    lower.includes("touch") ||
    lower.includes("did it")
  ) {
    completed++;
  }

  // Check for clap mention
  if (lower.includes("clap") || lower.includes("clapped")) {
    completed++;
  }

  // Check for color mention (any color word suggests they said their favorite)
  const colors = [
    "blue", "red", "green", "yellow", "orange", "purple",
    "pink", "brown", "black", "white", "gray", "grey",
  ];
  if (colors.some((c) => lower.includes(c))) {
    completed++;
  }

  // If transcript is empty or very short, they might have done it silently
  // Give benefit of the doubt for physical actions
  if (transcript.trim().length < 5) {
    // At minimum, assume they tried
    completed = Math.max(completed, 1);
  }

  return Math.min(completed, 3);
}
