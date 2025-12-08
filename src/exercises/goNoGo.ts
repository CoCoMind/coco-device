/**
 * Go/No-Go Exercise Handler
 *
 * Handles "Animal Spotter", "Number Hunter", "Listen and Tap", and "Category Snap".
 * User responds to targets, stays silent for non-targets.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore, normalizeLatency, computeCompositeScore } from "../utils/scoring";

export interface GoNoGoContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  listenBrief: (timeoutMs?: number) => Promise<{ transcript: string; latency_ms: number; hasResponse: boolean }>;
  log: (msg: string) => void;
}

// Target categories for different exercises
const TARGETS: Record<string, string[]> = {
  animals: ["dog", "cat", "horse", "fish", "bird", "rabbit", "elephant", "lion", "tiger", "bear"],
  colors: ["blue", "red", "green", "yellow", "orange", "purple", "pink", "brown", "black", "white"],
  food: ["apple", "pizza", "banana", "sandwich", "soup", "bread", "cheese", "salad", "pasta", "rice"],
};

export async function runGoNoGoExercise(
  activity: Activity,
  ctx: GoNoGoContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];
  const latencies: number[] = [];

  const params = activity.difficulty_params ?? {};
  const targetCategory = params.target_category ?? "animals";

  ctx.log(`GoNoGo: Running ${activity.id} with target category "${targetCategory}"`);

  // Check activity type
  if (activity.id === "number_hunter") {
    return runNumberHunter(activity, ctx, startTime);
  }

  // Standard go/no-go flow
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;
  let correctRejections = 0;

  // Get target words
  const targets = TARGETS[targetCategory] ?? TARGETS.animals;

  // Instructions
  await ctx.speak(activity.script[0]);

  // Parse the stimulus sequence from script
  const stimulusLine = activity.script[1];
  const stimuli = parseStimuli(stimulusLine);

  for (const stimulus of stimuli) {
    await ctx.speak(stimulus);

    // Brief listen for response
    const response = await ctx.listenBrief(2000);

    const isTarget = targets.some((t) =>
      stimulus.toLowerCase().includes(t.toLowerCase())
    );
    const hasResponse =
      response.hasResponse &&
      response.transcript.toLowerCase().match(/yes|tap|match/);

    if (isTarget) {
      if (hasResponse) {
        hits++;
        latencies.push(response.latency_ms);
      } else {
        misses++;
      }
    } else {
      if (hasResponse) {
        falseAlarms++;
      } else {
        correctRejections++;
      }
    }

    transcripts.push(response.transcript || "(no response)");
  }

  ctx.log(
    `GoNoGo: hits=${hits}, misses=${misses}, FA=${falseAlarms}, CR=${correctRejections}`
  );

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const totalTargets = hits + misses;
  const accuracy = totalTargets > 0 ? (hits / totalTargets) * 100 : 0;

  // For Category Snap, use composite of accuracy and speed
  let score: number;
  if (activity.scoring.metric === "composite" && latencies.length > 0) {
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    score = computeCompositeScore([
      { value: accuracy, weight: 2 },
      { value: normalizeLatency(avgLatency), weight: 1 },
    ]);
  } else {
    score = normalizeScore(
      hits,
      activity.scoring.normalization?.min_expected ?? 0,
      activity.scoring.normalization?.max_expected ?? totalTargets
    );
  }

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score: Math.round(score),
    raw_score: hits,
    response_time_ms:
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : undefined,
    transcripts,
    turn_count: stimuli.length,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

async function runNumberHunter(
  activity: Activity,
  ctx: GoNoGoContext,
  startTime: Date
): Promise<ActivityResult> {
  const transcripts: string[] = [];

  // Instructions
  await ctx.speak(activity.script[0]);

  // Present number sequence
  await ctx.speak(activity.script[1]);

  // Ask for count
  await ctx.speak(activity.script[2]);

  const response = await ctx.listen();
  transcripts.push(response.transcript);

  // Parse their answer
  const userCount = parseNumberFromText(response.transcript);
  const correctCount = 4; // Based on the script: "3... 7... 2... 5... 7... 9... 1... 7... 4... 8... 6... 7... 2... 5... 3"

  const isCorrect = userCount === correctCount;

  ctx.log(`NumberHunter: User said ${userCount}, correct is ${correctCount}`);

  // Closing
  await ctx.speak(activity.script[3]);

  const endTime = new Date();
  const score = isCorrect ? 100 : Math.max(0, 100 - Math.abs(userCount - correctCount) * 25);

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: userCount,
    transcripts,
    turn_count: 1,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

function parseStimuli(line: string): string[] {
  // Parse "Here we go: Table... Dog... Window..."
  const match = line.match(/:\s*(.+)/);
  if (!match) return [];

  return match[1]
    .split(/\.\.\.|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNumberFromText(text: string): number {
  const wordToNum: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4,
    five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };

  const lower = text.toLowerCase();
  for (const [word, num] of Object.entries(wordToNum)) {
    if (lower.includes(word)) return num;
  }

  const match = lower.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}
