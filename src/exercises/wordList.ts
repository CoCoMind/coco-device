/**
 * Word List Exercise Handler
 *
 * Handles "Word Garden - Plant" (immediate recall) and "Word Garden - Harvest" (delayed recall).
 * Tracks which words are remembered for scoring.
 */

import { Activity, ActivityResult } from "../types/activity";
import { normalizeScore, countUniqueWords } from "../utils/scoring";

export interface WordListContext {
  speak: (text: string) => Promise<void>;
  listen: () => Promise<{ transcript: string; latency_ms: number }>;
  log: (msg: string) => void;
  // Session state for tracking planted words across activities
  getSessionState: () => { plantedWords?: string[] };
  setSessionState: (state: { plantedWords?: string[] }) => void;
}

// Default word list for the Word Garden
const WORD_GARDEN_WORDS = [
  "Apple",
  "Bicycle",
  "Sunset",
  "Garden",
  "Music",
  "Elephant",
  "Kitchen",
  "Rainbow",
];

export async function runWordListExercise(
  activity: Activity,
  ctx: WordListContext
): Promise<ActivityResult> {
  const startTime = new Date();
  const transcripts: string[] = [];

  const params = activity.difficulty_params ?? {};
  const isDelayed = params.delay_type === "delayed";
  const wordCount = params.word_count ?? 8;

  ctx.log(`WordList: Running ${isDelayed ? "delayed" : "immediate"} recall`);

  let wordsToRecall: string[] = WORD_GARDEN_WORDS.slice(0, wordCount);
  let recalledWords: string[] = [];

  if (isDelayed) {
    // Delayed recall - retrieve planted words from session state
    const sessionState = ctx.getSessionState();
    if (sessionState.plantedWords && sessionState.plantedWords.length > 0) {
      wordsToRecall = sessionState.plantedWords;
    }

    // Ask for delayed recall
    await ctx.speak(activity.script[0]); // "Remember those words..."
    await ctx.speak(activity.script[1]); // "Take your time..."

    const response = await ctx.listen();
    transcripts.push(response.transcript);

    recalledWords = matchRecalledWords(response.transcript, wordsToRecall);
    ctx.log(
      `WordList: Delayed recall - got ${recalledWords.length}/${wordsToRecall.length} words`
    );

    const closingMsg = activity.script[2].replace(
      "[X]",
      String(recalledWords.length)
    );
    await ctx.speak(closingMsg);
  } else {
    // Immediate recall - present words and test
    await ctx.speak(activity.script[0]); // Instructions

    // Present the word list
    const wordListStr = wordsToRecall.join("... ");
    await ctx.speak(activity.script[1].replace(/Apple.*Rainbow/, wordListStr));

    // Store words for later delayed recall
    ctx.setSessionState({ plantedWords: wordsToRecall });

    // Ask for immediate recall
    await ctx.speak(activity.script[2]); // "Now tell me as many..."

    const response = await ctx.listen();
    transcripts.push(response.transcript);

    recalledWords = matchRecalledWords(response.transcript, wordsToRecall);
    ctx.log(
      `WordList: Immediate recall - got ${recalledWords.length}/${wordsToRecall.length} words`
    );

    // Closing - mention we'll check back later
    await ctx.speak(activity.script[3]); // "Wonderful! Let's see how many..."
  }

  const endTime = new Date();
  const score = normalizeScore(
    recalledWords.length,
    activity.scoring.normalization?.min_expected ?? 1,
    activity.scoring.normalization?.max_expected ?? wordCount
  );

  return {
    activity_id: activity.id,
    cognitive_domain: activity.cognitive_domain,
    score,
    raw_score: recalledWords.length,
    transcripts,
    turn_count: transcripts.length,
    difficulty_used: activity.difficulty,
    completed: true,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    duration_sec: Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  };
}

/**
 * Match words in the transcript against the target word list
 */
function matchRecalledWords(transcript: string, targetWords: string[]): string[] {
  const spokenWords = countUniqueWords(transcript);
  const targetLower = targetWords.map((w) => w.toLowerCase());

  return spokenWords.filter((word) => targetLower.includes(word));
}
