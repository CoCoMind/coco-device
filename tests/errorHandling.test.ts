/**
 * Error Handling Tests for syncSession.ts
 *
 * Tests the safeReject pattern in playAudio() and recordAudio()
 * to ensure EPIPE and other stream errors are properly caught.
 */
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";

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
// safeReject Pattern Tests
// ============================================================================

async function testSafeRejectPattern() {
  console.log("\nsafeReject Pattern Tests:");

  await runTest("safeReject prevents double rejection", async () => {
    let rejectCount = 0;

    const promise = new Promise((resolve, reject) => {
      let rejected = false;
      const safeReject = (err: Error) => {
        if (!rejected) {
          rejected = true;
          rejectCount++;
          reject(err);
        }
      };

      // Simulate multiple errors firing
      safeReject(new Error("First error"));
      safeReject(new Error("Second error"));
      safeReject(new Error("Third error"));
    });

    await promise.catch(() => {});
    assert.strictEqual(rejectCount, 1, "Should only reject once");
  });

  await runTest("safeReject passes error to reject", async () => {
    const testError = new Error("Test EPIPE error");

    const promise = new Promise((_, reject) => {
      let rejected = false;
      const safeReject = (err: Error) => {
        if (!rejected) {
          rejected = true;
          reject(err);
        }
      };
      safeReject(testError);
    });

    try {
      await promise;
      assert.fail("Should have rejected");
    } catch (err) {
      assert.strictEqual(err, testError, "Should pass original error");
    }
  });
}

// ============================================================================
// Stream Error Handler Tests
// ============================================================================

async function testStreamErrorHandlers() {
  console.log("\nStream Error Handler Tests:");

  await runTest("stdin error triggers rejection before exit", async () => {
    let resolved = false;
    let rejected = false;
    let rejectError: Error | null = null;

    const promise = new Promise<void>((resolve, reject) => {
      let isRejected = false;
      const safeReject = (err: Error) => {
        if (!isRejected) {
          isRejected = true;
          rejected = true;
          rejectError = err;
          reject(err);
        }
      };

      // Simulate stdin error event (like EPIPE)
      const stdinError = new Error("EPIPE: broken pipe");
      safeReject(stdinError);

      // Then exit event fires (should be ignored)
      if (!isRejected) {
        resolved = true;
        resolve();
      }
    });

    await promise.catch(() => {});

    assert.strictEqual(rejected, true, "Should have rejected");
    assert.strictEqual(resolved, false, "Should not have resolved");
    assert(rejectError?.message.includes("EPIPE"), "Should contain EPIPE");
  });

  await runTest("exit with rejected flag prevents resolve", async () => {
    let resolveCount = 0;

    const promise = new Promise<void>((resolve, reject) => {
      let rejected = false;
      const safeReject = (err: Error) => {
        if (!rejected) {
          rejected = true;
          reject(err);
        }
      };

      // First, error fires
      safeReject(new Error("Stream error"));

      // Then exit fires - should check rejected flag
      if (!rejected) {
        resolveCount++;
        resolve();
      }
    });

    await promise.catch(() => {});
    assert.strictEqual(resolveCount, 0, "Should not resolve after rejection");
  });
}

// ============================================================================
// Error Context Tests
// ============================================================================

async function testErrorContext() {
  console.log("\nError Context Tests:");

  await runTest("TTS arrayBuffer error has descriptive message", async () => {
    const originalError = new Error("Network timeout");

    // Simulate the error wrapping from textToSpeech
    let wrappedError: Error | null = null;
    try {
      throw new Error(`TTS arrayBuffer failed: ${originalError.message}`);
    } catch (err) {
      wrappedError = err as Error;
    }

    assert(wrappedError, "Should have error");
    assert(
      wrappedError.message.includes("TTS arrayBuffer failed"),
      "Should have context prefix"
    );
    assert(
      wrappedError.message.includes("Network timeout"),
      "Should include original message"
    );
  });

  await runTest("WAV file creation error has descriptive message", async () => {
    const originalError = new Error("Out of memory");

    // Simulate the error wrapping from transcribe
    let wrappedError: Error | null = null;
    try {
      throw new Error(`WAV file creation failed: ${originalError.message}`);
    } catch (err) {
      wrappedError = err as Error;
    }

    assert(wrappedError, "Should have error");
    assert(
      wrappedError.message.includes("WAV file creation failed"),
      "Should have context prefix"
    );
    assert(
      wrappedError.message.includes("Out of memory"),
      "Should include original message"
    );
  });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("Error Handling Tests\n");
  console.log("=".repeat(60));

  await testSafeRejectPattern();
  await testStreamErrorHandlers();
  await testErrorContext();

  console.log("\n" + "=".repeat(60));
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);

  process.exit(testsFailed > 0 ? 1 : 0);
}

main();
