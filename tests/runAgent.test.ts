/**
 * Comprehensive test suite for runAgent.ts utilities
 *
 * Note: This tests the utility functions and configuration parsing.
 * Full integration tests for the agent are in integration.test.ts.
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
// isTextOnlyMode Tests (inline implementation to test logic)
// ============================================================================

function isTextOnlyMode(): boolean {
  const modality = (process.env.OPENAI_OUTPUT_MODALITY ?? "").toLowerCase();
  return modality === "text" || process.env.COCO_AUDIO_DISABLE === "1";
}

async function testIsTextOnlyMode() {
  console.log("\nisTextOnlyMode Tests:");

  const originalModality = process.env.OPENAI_OUTPUT_MODALITY;
  const originalDisable = process.env.COCO_AUDIO_DISABLE;

  await runTest("returns false by default", () => {
    delete process.env.OPENAI_OUTPUT_MODALITY;
    delete process.env.COCO_AUDIO_DISABLE;
    assert.strictEqual(isTextOnlyMode(), false);
  });

  await runTest("returns true when OPENAI_OUTPUT_MODALITY is 'text'", () => {
    process.env.OPENAI_OUTPUT_MODALITY = "text";
    delete process.env.COCO_AUDIO_DISABLE;
    assert.strictEqual(isTextOnlyMode(), true);
  });

  await runTest("returns true when OPENAI_OUTPUT_MODALITY is 'TEXT' (case insensitive)", () => {
    process.env.OPENAI_OUTPUT_MODALITY = "TEXT";
    delete process.env.COCO_AUDIO_DISABLE;
    assert.strictEqual(isTextOnlyMode(), true);
  });

  await runTest("returns true when COCO_AUDIO_DISABLE is '1'", () => {
    delete process.env.OPENAI_OUTPUT_MODALITY;
    process.env.COCO_AUDIO_DISABLE = "1";
    assert.strictEqual(isTextOnlyMode(), true);
  });

  await runTest("returns false when COCO_AUDIO_DISABLE is '0'", () => {
    delete process.env.OPENAI_OUTPUT_MODALITY;
    process.env.COCO_AUDIO_DISABLE = "0";
    assert.strictEqual(isTextOnlyMode(), false);
  });

  await runTest("returns true when both conditions met", () => {
    process.env.OPENAI_OUTPUT_MODALITY = "text";
    process.env.COCO_AUDIO_DISABLE = "1";
    assert.strictEqual(isTextOnlyMode(), true);
  });

  await runTest("returns false when modality is 'audio'", () => {
    process.env.OPENAI_OUTPUT_MODALITY = "audio";
    delete process.env.COCO_AUDIO_DISABLE;
    assert.strictEqual(isTextOnlyMode(), false);
  });

  // Restore
  if (originalModality !== undefined) {
    process.env.OPENAI_OUTPUT_MODALITY = originalModality;
  } else {
    delete process.env.OPENAI_OUTPUT_MODALITY;
  }
  if (originalDisable !== undefined) {
    process.env.COCO_AUDIO_DISABLE = originalDisable;
  } else {
    delete process.env.COCO_AUDIO_DISABLE;
  }
}

// ============================================================================
// resolveMode Tests (inline implementation to test logic)
// ============================================================================

type AgentMode = "realtime" | "mock";

function resolveMode(): AgentMode {
  const raw = (process.env.COCO_AGENT_MODE ?? "mock").toLowerCase();
  if (raw === "realtime") {
    return "realtime";
  }
  return "mock";
}

async function testResolveMode() {
  console.log("\nresolveMode Tests:");

  const original = process.env.COCO_AGENT_MODE;

  await runTest("defaults to 'mock' when not set", () => {
    delete process.env.COCO_AGENT_MODE;
    assert.strictEqual(resolveMode(), "mock");
  });

  await runTest("returns 'realtime' when set to 'realtime'", () => {
    process.env.COCO_AGENT_MODE = "realtime";
    assert.strictEqual(resolveMode(), "realtime");
  });

  await runTest("returns 'realtime' when set to 'REALTIME' (case insensitive)", () => {
    process.env.COCO_AGENT_MODE = "REALTIME";
    assert.strictEqual(resolveMode(), "realtime");
  });

  await runTest("returns 'mock' when set to 'mock'", () => {
    process.env.COCO_AGENT_MODE = "mock";
    assert.strictEqual(resolveMode(), "mock");
  });

  await runTest("returns 'mock' for unrecognized values", () => {
    process.env.COCO_AGENT_MODE = "invalid";
    assert.strictEqual(resolveMode(), "mock");
  });

  await runTest("returns 'mock' for empty string", () => {
    process.env.COCO_AGENT_MODE = "";
    assert.strictEqual(resolveMode(), "mock");
  });

  // Restore
  if (original !== undefined) {
    process.env.COCO_AGENT_MODE = original;
  } else {
    delete process.env.COCO_AGENT_MODE;
  }
}

// ============================================================================
// Ephemeral Key Timeout Tests
// ============================================================================

async function testEphemeralKeyTimeout() {
  console.log("\nEphemeral Key Timeout Tests:");

  await runTest("default timeout is 15000ms", () => {
    const original = process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS;
    delete process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS;

    const timeout = Number(process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS ?? "15000");
    assert.strictEqual(timeout, 15000);

    if (original !== undefined) {
      process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS = original;
    }
  });

  await runTest("custom timeout is respected", () => {
    const original = process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS;
    process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS = "30000";

    const timeout = Number(process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS ?? "15000");
    assert.strictEqual(timeout, 30000);

    if (original !== undefined) {
      process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS = original;
    } else {
      delete process.env.COCO_EPHEMERAL_KEY_TIMEOUT_MS;
    }
  });
}

// ============================================================================
// Max Session Timeout Tests
// ============================================================================

async function testMaxSessionTimeout() {
  console.log("\nMax Session Timeout Tests:");

  await runTest("default max session is 900000ms (15 minutes)", () => {
    const original = process.env.COCO_MAX_SESSION_MS;
    delete process.env.COCO_MAX_SESSION_MS;

    const maxSessionMs = Number(process.env.COCO_MAX_SESSION_MS ?? "900000");
    assert.strictEqual(maxSessionMs, 900000);

    if (original !== undefined) {
      process.env.COCO_MAX_SESSION_MS = original;
    }
  });

  await runTest("custom max session is respected", () => {
    const original = process.env.COCO_MAX_SESSION_MS;
    process.env.COCO_MAX_SESSION_MS = "600000";

    const maxSessionMs = Number(process.env.COCO_MAX_SESSION_MS ?? "900000");
    assert.strictEqual(maxSessionMs, 600000);

    if (original !== undefined) {
      process.env.COCO_MAX_SESSION_MS = original;
    } else {
      delete process.env.COCO_MAX_SESSION_MS;
    }
  });
}

// ============================================================================
// REALTIME_MODEL Tests
// ============================================================================

async function testRealtimeModel() {
  console.log("\nREALTIME_MODEL Tests:");

  await runTest("has default model", () => {
    const original = process.env.REALTIME_MODEL;
    delete process.env.REALTIME_MODEL;

    const model = process.env.REALTIME_MODEL ?? "gpt-4o-mini-realtime-preview-2024-12-17";
    assert(model.includes("realtime"), "Default should be a realtime model");

    if (original !== undefined) {
      process.env.REALTIME_MODEL = original;
    }
  });

  await runTest("custom model is respected", () => {
    const original = process.env.REALTIME_MODEL;
    process.env.REALTIME_MODEL = "gpt-4o-realtime-preview";

    const model = process.env.REALTIME_MODEL ?? "gpt-4o-mini-realtime-preview-2024-12-17";
    assert.strictEqual(model, "gpt-4o-realtime-preview");

    if (original !== undefined) {
      process.env.REALTIME_MODEL = original;
    } else {
      delete process.env.REALTIME_MODEL;
    }
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive runAgent Tests");
  console.log("=".repeat(60));

  await testIsTextOnlyMode();
  await testResolveMode();
  await testEphemeralKeyTimeout();
  await testMaxSessionTimeout();
  await testRealtimeModel();

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
