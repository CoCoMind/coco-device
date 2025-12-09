/**
 * Scoring Utilities
 *
 * Functions for normalizing raw scores to 0-100 scale
 * and computing composite scores.
 */

/**
 * Normalize a raw score to 0-100 based on expected range
 */
export function normalizeScore(
  rawScore: number,
  minExpected: number,
  maxExpected: number
): number {
  if (maxExpected === minExpected) return 50;

  const normalized =
    ((rawScore - minExpected) / (maxExpected - minExpected)) * 100;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

/**
 * Normalize digit span score (typical range 3-9)
 */
export function normalizeDigitSpan(span: number): number {
  return normalizeScore(span, 3, 9);
}

/**
 * Normalize verbal fluency word count (typical range 5-25)
 */
export function normalizeWordCount(count: number): number {
  return normalizeScore(count, 5, 25);
}

/**
 * Normalize accuracy as percentage (already 0-100)
 */
export function normalizeAccuracy(correct: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((correct / total) * 100);
}

/**
 * Normalize response latency (lower is better)
 * Fast: < 1000ms = 100, Slow: > 3000ms = 0
 */
export function normalizeLatency(latencyMs: number): number {
  const minLatency = 500; // Very fast
  const maxLatency = 3000; // Slow

  if (latencyMs <= minLatency) return 100;
  if (latencyMs >= maxLatency) return 0;

  // Invert: lower latency = higher score
  const normalized =
    ((maxLatency - latencyMs) / (maxLatency - minLatency)) * 100;
  return Math.round(normalized);
}

/**
 * Compute composite score from multiple metrics
 */
export function computeCompositeScore(
  scores: { value: number; weight?: number }[]
): number {
  if (scores.length === 0) return 0;

  const totalWeight = scores.reduce((sum, s) => sum + (s.weight ?? 1), 0);
  const weightedSum = scores.reduce(
    (sum, s) => sum + s.value * (s.weight ?? 1),
    0
  );

  return Math.round(weightedSum / totalWeight);
}

/**
 * Calculate trend from recent scores
 */
export function calculateTrend(
  scores: number[]
): "improving" | "stable" | "declining" {
  if (scores.length < 3) return "stable";

  const midpoint = Math.floor(scores.length / 2);
  const firstHalf = scores.slice(0, midpoint);
  const secondHalf = scores.slice(midpoint);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const difference = secondAvg - firstAvg;

  if (difference > 5) return "improving";
  if (difference < -5) return "declining";
  return "stable";
}

/**
 * Parse numbers from spoken text
 * "4 7 2" or "four seven two" -> [4, 7, 2]
 */
export function parseSpokenNumbers(text: string): number[] {
  const wordToNum: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
  };

  const words = text.toLowerCase().split(/[\s,.-]+/);
  const numbers: number[] = [];

  for (const word of words) {
    if (wordToNum[word] !== undefined) {
      numbers.push(wordToNum[word]);
    } else {
      const num = parseInt(word, 10);
      if (!isNaN(num) && num >= 0 && num <= 9) {
        numbers.push(num);
      }
    }
  }

  return numbers;
}

/**
 * Compare digit sequences for digit span scoring
 */
export function compareDigitSequences(
  spoken: string,
  expected: number[],
  direction: "forward" | "backward" = "forward"
): boolean {
  const spokenNumbers = parseSpokenNumbers(spoken);
  const target =
    direction === "backward" ? [...expected].reverse() : expected;

  if (spokenNumbers.length !== target.length) return false;

  return spokenNumbers.every((num, i) => num === target[i]);
}

/**
 * Count words in verbal fluency response
 * Filters out repetitions and validates basic word structure
 */
export function countUniqueWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[\s,;.!?]+/)
    .filter((w) => w.length >= 2)
    .filter((w) => /^[a-z]+$/.test(w));

  // Remove duplicates
  return [...new Set(words)];
}

/**
 * Generate random digit sequence
 */
export function generateDigitSequence(length: number): number[] {
  const digits: number[] = [];
  for (let i = 0; i < length; i++) {
    digits.push(Math.floor(Math.random() * 10));
  }
  return digits;
}

/**
 * Generate word list for memory exercises
 */
export function generateWordList(count: number): string[] {
  const wordPool = [
    "apple",
    "bicycle",
    "sunset",
    "garden",
    "music",
    "elephant",
    "kitchen",
    "rainbow",
    "mountain",
    "ocean",
    "butterfly",
    "chocolate",
    "diamond",
    "forest",
    "guitar",
    "horizon",
    "island",
    "journey",
    "lantern",
    "meadow",
  ];

  // Shuffle and take first `count` words
  const shuffled = [...wordPool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
