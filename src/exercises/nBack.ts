/**
 * N-Back Exercise Handler
 *
 * Handles "Word Match Game" - say 'match' when you hear a word that appeared N positions ago.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore } from "../utils/scoring";

export interface NBackContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  listenBrief: (timeoutMs?: number) => Promise<{ transcript: string; latency_ms: number; hasResponse: boolean }>;
  log: (msg: string) => void;
}

export async function runNBackExercise(
  activity: Activity,
  ctx: NBackContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];
  const latencies: number[] = [];

  const params = activity.difficulty_params ?? {};
  const nLevel = params.n_level ?? 2;

  ctx.log(`NBack: Running ${nLevel}-back task`);

  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;
  let correctRejections = 0;

  // Instructions
  await ctx.speak(activity.script[0]);

  // Practice round
  await ctx.speak(activity.script[1]); // "Let's practice: Dog... Tree... Dog"

  const practiceResponse = await ctx.listen();
  transcripts.push(practiceResponse.transcript);

  // Main trial - parse the word sequence
  const trialLine = activity.script[2];
  const words = parseWordSequence(trialLine);

  ctx.log(`NBack: Presenting ${words.length} words`);

  // Build the sequence with match tracking
  const isMatch: boolean[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i >= nLevel && words[i].toLowerCase() === words[i - nLevel].toLowerCase()) {
      isMatch.push(true);
    } else {
      isMatch.push(false);
    }
  }

  // Present each word and check for response
  for (let i = 0; i < words.length; i++) {
    await ctx.speak(words[i]);

    // Brief listen for "match" response
    const response = await ctx.listenBrief(2000);
    const saidMatch = response.hasResponse &&
      response.transcript.toLowerCase().includes("match");

    if (isMatch[i]) {
      if (saidMatch) {
        hits++;
        latencies.push(response.latency_ms);
      } else {
        misses++;
      }
    } else {
      if (saidMatch) {
        falseAlarms++;
      } else {
        correctRejections++;
      }
    }

    transcripts.push(response.transcript || "(no response)");
  }

  ctx.log(
    `NBack: hits=${hits}, misses=${misses}, FA=${falseAlarms}, CR=${correctRejections}`
  );

  // Closing
  await ctx.speak(activity.script[activity.script.length - 1]);

  const endTime = new Date();
  const totalTargets = hits + misses;

  // D-prime approximation: hits - false alarms (simplified)
  const rawScore = hits - falseAlarms;
  const score = normalizeScore(
    hits,
    activity.scoring.normalization?.min_expected ?? 2,
    activity.scoring.normalization?.max_expected ?? totalTargets
  );

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: rawScore,
    response_time_ms:
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : undefined,
    transcripts,
    turn_count: words.length,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

function parseWordSequence(line: string): string[] {
  // Parse "Now the real game: Apple... House... Apple..."
  const match = line.match(/:\s*(.+)/);
  if (!match) return [];

  return match[1]
    .split(/\.\.\.|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
