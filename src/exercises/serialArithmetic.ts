/**
 * Serial Arithmetic Exercise Handler
 *
 * Handles "Countdown Challenge" - counting backwards by a specified number.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore } from "../utils/scoring";

export interface SerialArithmeticContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  listenForDuration: (
    seconds: number,
    encourageCallback?: () => Promise<void>
  ) => Promise<{ transcript: string; latency_ms: number }>;
  log: (msg: string) => void;
}

export async function runSerialArithmeticExercise(
  activity: Activity,
  ctx: SerialArithmeticContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];

  const params = activity.difficulty_params ?? {};
  const startNumber = params.start_number ?? 50;
  const subtractBy = params.subtract_by ?? 3;

  ctx.log(`SerialArithmetic: ${startNumber} - ${subtractBy}...`);

  // Instructions
  await ctx.speak(activity.script[0]);

  // Listen for their counting
  const response = await ctx.listenForDuration(30, async () => {
    if (activity.script[1]) {
      await ctx.speak(activity.script[1]); // "You're doing great, keep going!"
    }
  });

  transcripts.push(response.transcript);

  // Parse their responses and count errors
  const { correctCount, errors, lastNumber } = analyzeSerialSubtraction(
    response.transcript,
    startNumber,
    subtractBy
  );

  ctx.log(
    `SerialArithmetic: ${correctCount} correct, ${errors} errors, ended at ${lastNumber}`
  );

  // Closing
  const closingScript = activity.script[activity.script.length - 1];
  await ctx.speak(closingScript.replace("[X]", String(lastNumber)));

  const endTime = new Date();

  // Score based on number of correct responses
  const score = normalizeScore(
    correctCount,
    activity.scoring.normalization?.min_expected ?? 5,
    activity.scoring.normalization?.max_expected ?? 15
  );

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: correctCount,
    transcripts,
    turn_count: 1,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

interface SubtractionResult {
  correctCount: number;
  errors: number;
  lastNumber: number;
}

function analyzeSerialSubtraction(
  transcript: string,
  start: number,
  subtractBy: number
): SubtractionResult {
  // Extract all numbers from transcript
  const numbers = extractNumbers(transcript);

  if (numbers.length === 0) {
    return { correctCount: 0, errors: 0, lastNumber: start };
  }

  let correctCount = 0;
  let errors = 0;
  let expected = start;
  let lastNumber = start;

  for (const num of numbers) {
    if (num === expected) {
      correctCount++;
      lastNumber = num;
      expected -= subtractBy;
    } else if (num === expected - subtractBy) {
      // They skipped one - might have just not said it
      expected = num - subtractBy;
      correctCount++;
      lastNumber = num;
    } else if (num < expected && num > expected - subtractBy * 3) {
      // Close enough - might be a mishearing
      errors++;
      lastNumber = num;
      expected = num - subtractBy;
    } else {
      // Too far off - count as error
      errors++;
    }
  }

  return { correctCount, errors, lastNumber };
}

function extractNumbers(text: string): number[] {
  const wordToNum: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50,
  };

  const words = text.toLowerCase().split(/[\s,.-]+/);
  const numbers: number[] = [];

  let compound = 0;
  let hasCompound = false;

  for (const word of words) {
    // Check word numbers
    if (wordToNum[word] !== undefined) {
      const num = wordToNum[word];
      if (num >= 20 && num % 10 === 0) {
        // Tens place (twenty, thirty, etc.)
        compound = num;
        hasCompound = true;
      } else if (hasCompound && num < 10) {
        // Units after tens (forty-seven)
        numbers.push(compound + num);
        hasCompound = false;
        compound = 0;
      } else {
        if (hasCompound) {
          numbers.push(compound);
          hasCompound = false;
          compound = 0;
        }
        numbers.push(num);
      }
    } else {
      // Check digit numbers
      const match = word.match(/^\d+$/);
      if (match) {
        if (hasCompound) {
          numbers.push(compound);
          hasCompound = false;
          compound = 0;
        }
        numbers.push(parseInt(match[0], 10));
      }
    }
  }

  if (hasCompound) {
    numbers.push(compound);
  }

  return numbers;
}
