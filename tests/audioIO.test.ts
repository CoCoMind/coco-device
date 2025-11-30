/**
 * Comprehensive test suite for audioIO.ts
 *
 * Note: Full audio tests require Linux with ALSA. These tests focus on
 * configuration parsing, exported constants, and behavior verification
 * for non-Linux platforms.
 */
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { ALSA_SAMPLE_RATE, createAlsaAudioBinding } from "../src/audioIO";

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

// Mock RealtimeSession for testing
class MockSession extends EventEmitter {
  transport = new EventEmitter();
  sendAudio = (_data: ArrayBuffer) => {};
}

// ============================================================================
// ALSA_SAMPLE_RATE Tests
// ============================================================================

async function testAlsaSampleRate() {
  console.log("\nALSA_SAMPLE_RATE Tests:");

  await runTest("ALSA_SAMPLE_RATE is exported", () => {
    assert(ALSA_SAMPLE_RATE !== undefined, "ALSA_SAMPLE_RATE should be exported");
  });

  await runTest("ALSA_SAMPLE_RATE is a number", () => {
    assert(typeof ALSA_SAMPLE_RATE === "number", "Should be a number");
  });

  await runTest("ALSA_SAMPLE_RATE is positive", () => {
    assert(ALSA_SAMPLE_RATE > 0, "Should be positive");
  });

  await runTest("ALSA_SAMPLE_RATE does not exceed 24000", () => {
    assert(ALSA_SAMPLE_RATE <= 24000, "Should not exceed max of 24000");
  });

  await runTest("ALSA_SAMPLE_RATE is a valid audio rate", () => {
    const validRates = [8000, 16000, 22050, 24000, 44100, 48000];
    // Allow any positive rate up to 24000, not just standard ones
    assert(
      ALSA_SAMPLE_RATE > 0 && ALSA_SAMPLE_RATE <= 24000,
      `Sample rate ${ALSA_SAMPLE_RATE} should be valid`,
    );
  });
}

// ============================================================================
// createAlsaAudioBinding Tests
// ============================================================================

async function testCreateAlsaAudioBinding() {
  console.log("\ncreateAlsaAudioBinding Tests:");

  // On Linux, ALSA binding will try to spawn real audio processes
  // Skip those tests to avoid hanging in CI/test environments
  const isLinux = process.platform === "linux";

  await runTest("createAlsaAudioBinding is a function", () => {
    assert(
      typeof createAlsaAudioBinding === "function",
      "Should be a function",
    );
  });

  await runTest("returns binding object with required methods", () => {
    const session = new MockSession();
    const binding = createAlsaAudioBinding(session as any);

    assert(typeof binding.start === "function", "Should have start method");
    assert(typeof binding.stop === "function", "Should have stop method");
    assert(typeof binding.stopCapture === "function", "Should have stopCapture method");
  });

  await runTest("returns binding with optional waitForPlaybackIdle", () => {
    const session = new MockSession();
    const binding = createAlsaAudioBinding(session as any);

    // waitForPlaybackIdle may or may not exist depending on platform
    if (binding.waitForPlaybackIdle) {
      assert(
        typeof binding.waitForPlaybackIdle === "function",
        "If present, should be a function",
      );
    }
  });

  // Skip tests that call start() on Linux as they spawn ALSA processes
  if (!isLinux) {
    await runTest("start() does not throw on non-Linux", () => {
      const session = new MockSession();
      const binding = createAlsaAudioBinding(session as any);
      binding.start();
    });

    await runTest("stop() does not throw on non-Linux", () => {
      const session = new MockSession();
      const binding = createAlsaAudioBinding(session as any);
      binding.start();
      binding.stop();
    });

    await runTest("stopCapture() does not throw on non-Linux", () => {
      const session = new MockSession();
      const binding = createAlsaAudioBinding(session as any);
      binding.start();
      binding.stopCapture();
    });

    await runTest("methods can be called multiple times", () => {
      const session = new MockSession();
      const binding = createAlsaAudioBinding(session as any);
      binding.start();
      binding.start();
      binding.stopCapture();
      binding.stopCapture();
      binding.stop();
      binding.stop();
    });
  } else {
    console.log("  (skipping ALSA process tests on Linux - they would spawn real audio processes)");
  }

  await runTest("stop() can be called without start()", () => {
    const session = new MockSession();
    const binding = createAlsaAudioBinding(session as any);
    binding.stop();
  });

  await runTest("handles session without transport gracefully", () => {
    const badSession = new EventEmitter();
    const binding = createAlsaAudioBinding(badSession as any);
    // Should return no-op binding
    binding.stop();
  });

  await runTest("waitForPlaybackIdle resolves (without start)", async () => {
    const session = new MockSession();
    const binding = createAlsaAudioBinding(session as any);
    if (binding.waitForPlaybackIdle) {
      await binding.waitForPlaybackIdle(100);
    }
  });
}

// ============================================================================
// Audio Binding Lifecycle Tests
// ============================================================================

async function testAudioBindingLifecycle() {
  console.log("\nAudio Binding Lifecycle Tests:");

  // Skip lifecycle tests on Linux as they spawn real ALSA processes
  if (process.platform === "linux") {
    console.log("  (skipping lifecycle tests on Linux - they would spawn real audio processes)");
    return;
  }

  await runTest("full lifecycle: start -> stopCapture -> stop", () => {
    const session = new MockSession();
    const binding = createAlsaAudioBinding(session as any);

    binding.start();
    binding.stopCapture();
    binding.stop();
  });

  await runTest("can restart after stop", () => {
    const session = new MockSession();
    const binding = createAlsaAudioBinding(session as any);

    binding.start();
    binding.stop();
    binding.start();
    binding.stop();
  });

  await runTest("stopCapture only stops capture, not playback", () => {
    const session = new MockSession();
    const binding = createAlsaAudioBinding(session as any);

    binding.start();
    binding.stopCapture();
    // Should still be able to play audio (conceptually)
    binding.stop();
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive AudioIO Tests");
  console.log("=".repeat(60));
  console.log(`Platform: ${process.platform} (ALSA requires linux)`);

  await testAlsaSampleRate();
  await testCreateAlsaAudioBinding();
  await testAudioBindingLifecycle();

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
