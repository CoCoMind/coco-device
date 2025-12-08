/**
 * Tests for retry utility
 */
import assert from "node:assert";
import { withRetry, isRetryableError, type RetryableError } from "../src/retry";

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
// isRetryableError Tests
// ============================================================================

async function testIsRetryableError() {
  console.log("\nisRetryableError Tests:");

  await runTest("returns true for timeout errors", () => {
    const err = new Error("Request timeout after 30000ms");
    assert.strictEqual(isRetryableError(err), true);
  });

  await runTest("returns true for ECONNRESET", () => {
    const err = new Error("read ECONNRESET");
    assert.strictEqual(isRetryableError(err), true);
  });

  await runTest("returns true for ETIMEDOUT", () => {
    const err = new Error("connect ETIMEDOUT 1.2.3.4:443");
    assert.strictEqual(isRetryableError(err), true);
  });

  await runTest("returns true for fetch failed", () => {
    const err = new Error("fetch failed");
    assert.strictEqual(isRetryableError(err), true);
  });

  await runTest("returns true for network errors", () => {
    const err = new Error("Network error");
    assert.strictEqual(isRetryableError(err), true);
  });

  await runTest("returns true for ENOTFOUND", () => {
    const err = new Error("getaddrinfo ENOTFOUND api.openai.com");
    assert.strictEqual(isRetryableError(err), true);
  });

  await runTest("returns true for ECONNREFUSED", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    assert.strictEqual(isRetryableError(err), true);
  });

  await runTest("returns true for 5xx status codes", () => {
    const err = new Error("Internal Server Error") as RetryableError;
    err.status = 500;
    assert.strictEqual(isRetryableError(err), true);

    const err503 = new Error("Service Unavailable") as RetryableError;
    err503.status = 503;
    assert.strictEqual(isRetryableError(err503), true);
  });

  await runTest("returns false for 4xx status codes", () => {
    const err = new Error("Unauthorized") as RetryableError;
    err.status = 401;
    assert.strictEqual(isRetryableError(err), false);

    const err404 = new Error("Not Found") as RetryableError;
    err404.status = 404;
    assert.strictEqual(isRetryableError(err404), false);
  });

  await runTest("returns false for generic errors", () => {
    const err = new Error("Something went wrong");
    assert.strictEqual(isRetryableError(err), false);
  });

  await runTest("returns false for validation errors", () => {
    const err = new Error("Invalid API key");
    assert.strictEqual(isRetryableError(err), false);
  });
}

// ============================================================================
// withRetry Tests
// ============================================================================

async function testWithRetry() {
  console.log("\nwithRetry Tests:");

  await runTest("succeeds on first attempt when operation succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        return "success";
      },
      "test",
      { maxRetries: 2, delayMs: 10, logger: () => {} }
    );

    assert.strictEqual(result, "success");
    assert.strictEqual(attempts, 1);
  });

  await runTest("retries on retryable error and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("fetch failed");
        }
        return "success after retries";
      },
      "test",
      { maxRetries: 2, delayMs: 10, logger: () => {} }
    );

    assert.strictEqual(result, "success after retries");
    assert.strictEqual(attempts, 3);
  });

  await runTest("fails immediately on non-retryable error", async () => {
    let attempts = 0;
    try {
      await withRetry(
        async () => {
          attempts++;
          const err = new Error("Unauthorized") as RetryableError;
          err.status = 401;
          throw err;
        },
        "test",
        { maxRetries: 2, delayMs: 10, logger: () => {} }
      );
      assert.fail("Should have thrown");
    } catch (err) {
      assert.strictEqual(attempts, 1, "Should not retry on auth errors");
      assert.strictEqual((err as Error).message, "Unauthorized");
    }
  });

  await runTest("exhausts all retries on persistent retryable error", async () => {
    let attempts = 0;
    try {
      await withRetry(
        async () => {
          attempts++;
          throw new Error("timeout");
        },
        "test",
        { maxRetries: 2, delayMs: 10, logger: () => {} }
      );
      assert.fail("Should have thrown");
    } catch (err) {
      assert.strictEqual(attempts, 3, "Should try 1 + 2 retries = 3 attempts");
      assert.strictEqual((err as Error).message, "timeout");
    }
  });

  await runTest("respects maxRetries=0 (no retries)", async () => {
    let attempts = 0;
    try {
      await withRetry(
        async () => {
          attempts++;
          throw new Error("timeout");
        },
        "test",
        { maxRetries: 0, delayMs: 10, logger: () => {} }
      );
      assert.fail("Should have thrown");
    } catch (err) {
      assert.strictEqual(attempts, 1, "Should only try once with maxRetries=0");
    }
  });

  await runTest("calls logger on retry", async () => {
    const logs: string[] = [];
    let attempts = 0;

    try {
      await withRetry(
        async () => {
          attempts++;
          throw new Error("fetch failed");
        },
        "TestOp",
        { maxRetries: 1, delayMs: 10, logger: (msg) => logs.push(msg) }
      );
    } catch {
      // Expected
    }

    assert.strictEqual(attempts, 2);
    assert(logs.some(l => l.includes("TestOp")), "Logger should mention operation label");
    assert(logs.some(l => l.includes("retrying")), "Logger should mention retry");
    assert(logs.some(l => l.includes("FAILED")), "Logger should mention failure");
  });

  await runTest("preserves error type and properties", async () => {
    const originalError = new Error("Server Error") as RetryableError;
    originalError.status = 503;

    try {
      await withRetry(
        async () => {
          throw originalError;
        },
        "test",
        { maxRetries: 0, delayMs: 10, logger: () => {} }
      );
      assert.fail("Should have thrown");
    } catch (err) {
      assert.strictEqual(err, originalError, "Should preserve original error");
      assert.strictEqual((err as RetryableError).status, 503);
    }
  });

  await runTest("handles async operations correctly", async () => {
    const start = Date.now();
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        await new Promise(r => setTimeout(r, 20)); // Simulate API latency
        if (attempts < 2) {
          throw new Error("timeout");
        }
        return "async success";
      },
      "test",
      { maxRetries: 2, delayMs: 50, logger: () => {} }
    );

    const elapsed = Date.now() - start;
    assert.strictEqual(result, "async success");
    assert.strictEqual(attempts, 2);
    // Should have taken at least: 20ms (first attempt) + 50ms (delay) + 20ms (second attempt) = 90ms
    assert(elapsed >= 70, `Expected >= 70ms, got ${elapsed}ms`);
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Retry Utility Tests");
  console.log("=".repeat(60));

  await testIsRetryableError();
  await testWithRetry();

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
