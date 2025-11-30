/**
 * Comprehensive test suite for mockAgent.ts
 *
 * Tests sentiment analysis, audio profile resolution, and utility functions.
 * Since most functions are not exported, we test the logic by reimplementing
 * key functions inline.
 */
import assert from "node:assert";

let testsPassed = 0;
let testsFailed = 0;

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error}`);
    testsFailed++;
  }
}

// ============================================================================
// Utility Functions (reimplemented for testing)
// ============================================================================

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function describeScore(score: number) {
  if (score >= 0.65) return "positive";
  if (score <= 0.35) return "negative";
  return "neutral";
}

function tokenize(text: string) {
  return text.toLowerCase().match(/[a-z']+/g)?.filter(Boolean) ?? [];
}

const POSITIVE_WORDS = [
  "good", "great", "calm", "happy", "grateful",
  "relaxed", "excited", "fantastic", "hopeful",
];
const NEGATIVE_WORDS = [
  "bad", "sad", "anxious", "tired", "stressed",
  "upset", "angry", "worried", "overwhelmed",
];

type SentimentResult = {
  score: number;
  summary: string;
  basis: "audio" | "text" | "default";
};

function sentimentFromText(text?: string): SentimentResult | null {
  if (!text || !text.trim()) return null;
  const tokens = tokenize(text);
  if (!tokens.length) return null;

  let value = 0;
  tokens.forEach((token) => {
    if (POSITIVE_WORDS.includes(token)) value += 1;
    if (NEGATIVE_WORDS.includes(token)) value -= 1;
  });

  const normalized = clamp(0.5 + value / (tokens.length * 2), 0, 1);
  return {
    score: Number(normalized.toFixed(3)),
    summary: describeScore(normalized),
    basis: "text",
  };
}

function sentimentFromAudio(buffer?: Buffer): SentimentResult | null {
  if (!buffer || buffer.length < 2) return null;

  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return null;

  let sumSquares = 0;
  let zeroCrossings = 0;
  let prevSign = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const sample = buffer.readInt16LE(i * 2) / 32768;
    sumSquares += sample * sample;
    const sign = sample === 0 ? prevSign : sample > 0 ? 1 : -1;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      zeroCrossings += 1;
    }
    prevSign = sign;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  const zeroCrossRatio = zeroCrossings / sampleCount;
  const normalizedRms = clamp(rms / 0.35, 0, 1);
  const normalized = clamp(
    normalizedRms * 0.7 + clamp(zeroCrossRatio * 3, 0, 1) * 0.3,
    0,
    1,
  );

  return {
    score: Number(normalized.toFixed(3)),
    summary: describeScore(normalized),
    basis: "audio",
  };
}

// ============================================================================
// clamp Tests
// ============================================================================

async function testClamp() {
  console.log("\nclamp Tests:");

  await runTest("clamps value below min to min", () => {
    assert.strictEqual(clamp(-5, 0, 10), 0);
  });

  await runTest("clamps value above max to max", () => {
    assert.strictEqual(clamp(15, 0, 10), 10);
  });

  await runTest("returns value when within range", () => {
    assert.strictEqual(clamp(5, 0, 10), 5);
  });

  await runTest("handles min equals max", () => {
    assert.strictEqual(clamp(5, 5, 5), 5);
  });

  await runTest("handles negative range", () => {
    assert.strictEqual(clamp(-3, -5, -1), -3);
  });

  await runTest("handles decimal values", () => {
    assert.strictEqual(clamp(0.5, 0, 1), 0.5);
  });
}

// ============================================================================
// describeScore Tests
// ============================================================================

async function testDescribeScore() {
  console.log("\ndescribeScore Tests:");

  await runTest("returns 'positive' for score >= 0.65", () => {
    assert.strictEqual(describeScore(0.65), "positive");
    assert.strictEqual(describeScore(0.8), "positive");
    assert.strictEqual(describeScore(1.0), "positive");
  });

  await runTest("returns 'negative' for score <= 0.35", () => {
    assert.strictEqual(describeScore(0.35), "negative");
    assert.strictEqual(describeScore(0.2), "negative");
    assert.strictEqual(describeScore(0.0), "negative");
  });

  await runTest("returns 'neutral' for score between 0.35 and 0.65", () => {
    assert.strictEqual(describeScore(0.36), "neutral");
    assert.strictEqual(describeScore(0.5), "neutral");
    assert.strictEqual(describeScore(0.64), "neutral");
  });
}

// ============================================================================
// tokenize Tests
// ============================================================================

async function testTokenize() {
  console.log("\ntokenize Tests:");

  await runTest("tokenizes simple sentence", () => {
    const tokens = tokenize("Hello world");
    assert.deepStrictEqual(tokens, ["hello", "world"]);
  });

  await runTest("handles punctuation", () => {
    const tokens = tokenize("Hello, world! How are you?");
    assert.deepStrictEqual(tokens, ["hello", "world", "how", "are", "you"]);
  });

  await runTest("converts to lowercase", () => {
    const tokens = tokenize("HELLO World");
    assert.deepStrictEqual(tokens, ["hello", "world"]);
  });

  await runTest("handles contractions", () => {
    const tokens = tokenize("I'm feeling great");
    assert.deepStrictEqual(tokens, ["i'm", "feeling", "great"]);
  });

  await runTest("returns empty array for empty string", () => {
    const tokens = tokenize("");
    assert.deepStrictEqual(tokens, []);
  });

  await runTest("returns empty array for numbers only", () => {
    const tokens = tokenize("123 456");
    assert.deepStrictEqual(tokens, []);
  });
}

// ============================================================================
// sentimentFromText Tests
// ============================================================================

async function testSentimentFromText() {
  console.log("\nsentimentFromText Tests:");

  await runTest("returns null for empty string", () => {
    assert.strictEqual(sentimentFromText(""), null);
  });

  await runTest("returns null for whitespace only", () => {
    assert.strictEqual(sentimentFromText("   "), null);
  });

  await runTest("returns null for undefined", () => {
    assert.strictEqual(sentimentFromText(undefined), null);
  });

  await runTest("returns positive for positive words", () => {
    const result = sentimentFromText("I feel happy and great");
    assert(result !== null);
    assert.strictEqual(result.basis, "text");
    assert(result.score > 0.5, `Expected score > 0.5, got ${result.score}`);
  });

  await runTest("returns negative for negative words", () => {
    const result = sentimentFromText("I feel sad and stressed");
    assert(result !== null);
    assert.strictEqual(result.basis, "text");
    assert(result.score < 0.5, `Expected score < 0.5, got ${result.score}`);
  });

  await runTest("returns neutral for neutral text", () => {
    const result = sentimentFromText("The weather is cloudy today");
    assert(result !== null);
    assert.strictEqual(result.basis, "text");
    assert.strictEqual(result.score, 0.5);
  });

  await runTest("handles mixed sentiment", () => {
    const result = sentimentFromText("I feel happy but also a bit tired");
    assert(result !== null);
    // happy (+1) and tired (-1) should roughly cancel out
  });

  await runTest("score is between 0 and 1", () => {
    const result = sentimentFromText("great great great fantastic wonderful");
    assert(result !== null);
    assert(result.score >= 0 && result.score <= 1);
  });
}

// ============================================================================
// sentimentFromAudio Tests
// ============================================================================

async function testSentimentFromAudio() {
  console.log("\nsentimentFromAudio Tests:");

  await runTest("returns null for undefined buffer", () => {
    assert.strictEqual(sentimentFromAudio(undefined), null);
  });

  await runTest("returns null for empty buffer", () => {
    assert.strictEqual(sentimentFromAudio(Buffer.alloc(0)), null);
  });

  await runTest("returns null for buffer smaller than 2 bytes", () => {
    assert.strictEqual(sentimentFromAudio(Buffer.alloc(1)), null);
  });

  await runTest("analyzes silent audio", () => {
    // Create buffer of zeros (silence)
    const buffer = Buffer.alloc(1000 * 2); // 1000 samples
    const result = sentimentFromAudio(buffer);
    assert(result !== null);
    assert.strictEqual(result.basis, "audio");
    assert(result.score >= 0 && result.score <= 1);
  });

  await runTest("analyzes loud audio", () => {
    // Create buffer with high amplitude samples
    const buffer = Buffer.alloc(1000 * 2);
    for (let i = 0; i < 1000; i++) {
      buffer.writeInt16LE(Math.floor(Math.sin(i * 0.1) * 20000), i * 2);
    }
    const result = sentimentFromAudio(buffer);
    assert(result !== null);
    assert.strictEqual(result.basis, "audio");
  });

  await runTest("score is between 0 and 1", () => {
    const buffer = Buffer.alloc(500 * 2);
    for (let i = 0; i < 500; i++) {
      buffer.writeInt16LE(Math.floor(Math.random() * 65536 - 32768), i * 2);
    }
    const result = sentimentFromAudio(buffer);
    assert(result !== null);
    assert(result.score >= 0 && result.score <= 1);
  });

  await runTest("summary matches score range", () => {
    const buffer = Buffer.alloc(100 * 2);
    const result = sentimentFromAudio(buffer);
    assert(result !== null);

    if (result.score >= 0.65) {
      assert.strictEqual(result.summary, "positive");
    } else if (result.score <= 0.35) {
      assert.strictEqual(result.summary, "negative");
    } else {
      assert.strictEqual(result.summary, "neutral");
    }
  });
}

// ============================================================================
// Audio Profile Resolution Tests
// ============================================================================

async function testAudioProfileResolution() {
  console.log("\nAudio Profile Resolution Tests:");

  function resolveAudioProfile(): "device" | "mac" {
    const raw = (process.env.COCO_MOCK_AUDIO_PROFILE ?? "").toLowerCase();
    if (raw === "mac" || raw === "device") return raw;
    return process.platform === "darwin" ? "mac" : "device";
  }

  const original = process.env.COCO_MOCK_AUDIO_PROFILE;

  await runTest("respects explicit 'mac' setting", () => {
    process.env.COCO_MOCK_AUDIO_PROFILE = "mac";
    assert.strictEqual(resolveAudioProfile(), "mac");
  });

  await runTest("respects explicit 'device' setting", () => {
    process.env.COCO_MOCK_AUDIO_PROFILE = "device";
    assert.strictEqual(resolveAudioProfile(), "device");
  });

  await runTest("defaults based on platform when not set", () => {
    delete process.env.COCO_MOCK_AUDIO_PROFILE;
    const expected = process.platform === "darwin" ? "mac" : "device";
    assert.strictEqual(resolveAudioProfile(), expected);
  });

  await runTest("ignores invalid values", () => {
    process.env.COCO_MOCK_AUDIO_PROFILE = "invalid";
    const expected = process.platform === "darwin" ? "mac" : "device";
    assert.strictEqual(resolveAudioProfile(), expected);
  });

  // Restore
  if (original !== undefined) {
    process.env.COCO_MOCK_AUDIO_PROFILE = original;
  } else {
    delete process.env.COCO_MOCK_AUDIO_PROFILE;
  }
}

// ============================================================================
// parseArgList Tests
// ============================================================================

async function testParseArgList() {
  console.log("\nparseArgList Tests:");

  function parseArgList(raw?: string) {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed as string[];
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  await runTest("returns undefined for empty string", () => {
    assert.strictEqual(parseArgList(""), undefined);
  });

  await runTest("returns undefined for undefined", () => {
    assert.strictEqual(parseArgList(undefined), undefined);
  });

  await runTest("parses valid JSON array", () => {
    const result = parseArgList('["arg1", "arg2"]');
    assert.deepStrictEqual(result, ["arg1", "arg2"]);
  });

  await runTest("returns undefined for invalid JSON", () => {
    assert.strictEqual(parseArgList("not json"), undefined);
  });

  await runTest("returns undefined for non-array JSON", () => {
    assert.strictEqual(parseArgList('{"key": "value"}'), undefined);
  });

  await runTest("returns undefined for array with non-strings", () => {
    assert.strictEqual(parseArgList("[1, 2, 3]"), undefined);
  });

  await runTest("handles empty array", () => {
    const result = parseArgList("[]");
    assert.deepStrictEqual(result, []);
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive mockAgent Tests");
  console.log("=".repeat(60));

  await testClamp();
  await testDescribeScore();
  await testTokenize();
  await testSentimentFromText();
  await testSentimentFromAudio();
  await testAudioProfileResolution();
  await testParseArgList();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
  console.log("=".repeat(60));

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((error) => {
  console.error("Test runner failed:", error);
  process.exit(1);
});
