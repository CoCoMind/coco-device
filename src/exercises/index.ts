/**
 * Exercise Handler Registry
 *
 * Central export for all exercise handlers.
 */

export { runDigitSpanExercise, type DigitSpanContext } from "./digitSpan";
export { runWordListExercise, type WordListContext } from "./wordList";
export { runVerbalFluencyExercise, type VerbalFluencyContext } from "./verbalFluency";
export { runGoNoGoExercise, type GoNoGoContext } from "./goNoGo";
export { runSerialArithmeticExercise, type SerialArithmeticContext } from "./serialArithmetic";
export { runTaskSwitchingExercise, type TaskSwitchingContext } from "./taskSwitching";
export { runInstructionFollowingExercise, type InstructionFollowingContext } from "./instructionFollowing";
export { runNBackExercise, type NBackContext } from "./nBack";
export { runStoryRecallExercise, type StoryRecallContext } from "./storyRecall";
export { runConversationalExercise, type ConversationalContext } from "./conversational";

import { Activity, ActivityResult, ActivityType } from "../types/activity";

/**
 * Common context interface for all exercise handlers
 */
export interface ExerciseContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  listenBrief: (timeoutMs?: number) => Promise<{ transcript: string; latency_ms: number; hasResponse: boolean }>;
  listenForDuration: (
    seconds: number,
    encourageCallback?: () => Promise<void>
  ) => Promise<{ transcript: string; latency_ms: number }>;
  generateResponse: (
    userMessage: string,
    activity: Activity,
    turnNumber: number
  ) => Promise<{ text: string; shouldFollowUp: boolean }>;
  log: (msg: string) => void;
  getSessionState: () => { plantedWords?: string[] };
  setSessionState: (state: { plantedWords?: string[] }) => void;
}

/**
 * Route activity to appropriate handler based on type
 */
export async function runActivity(
  activity: Activity,
  ctx: ExerciseContext
): Promise<ActivityResult> {
  const { runDigitSpanExercise } = await import("./digitSpan");
  const { runWordListExercise } = await import("./wordList");
  const { runVerbalFluencyExercise } = await import("./verbalFluency");
  const { runGoNoGoExercise } = await import("./goNoGo");
  const { runSerialArithmeticExercise } = await import("./serialArithmetic");
  const { runTaskSwitchingExercise } = await import("./taskSwitching");
  const { runInstructionFollowingExercise } = await import("./instructionFollowing");
  const { runNBackExercise } = await import("./nBack");
  const { runStoryRecallExercise } = await import("./storyRecall");
  const { runConversationalExercise } = await import("./conversational");

  switch (activity.type) {
    case "digit_span":
      return runDigitSpanExercise(activity, ctx);

    case "word_list":
      return runWordListExercise(activity, ctx);

    case "verbal_fluency":
      return runVerbalFluencyExercise(activity, ctx);

    case "go_no_go":
      return runGoNoGoExercise(activity, ctx);

    case "serial_arithmetic":
      return runSerialArithmeticExercise(activity, ctx);

    case "task_switching":
      return runTaskSwitchingExercise(activity, ctx);

    case "instruction_following":
      return runInstructionFollowingExercise(activity, ctx);

    case "n_back":
      return runNBackExercise(activity, ctx);

    case "story_recall":
      return runStoryRecallExercise(activity, ctx);

    // All conversational types
    case "conversation":
    case "guided_recall":
    case "emotion_recognition":
    case "perspective_taking":
    case "orientation":
    case "closing":
      return runConversationalExercise(activity, ctx);

    default:
      // Fallback to conversational for unknown types
      ctx.log(`Unknown activity type: ${activity.type}, using conversational handler`);
      return runConversationalExercise(activity, ctx);
  }
}
