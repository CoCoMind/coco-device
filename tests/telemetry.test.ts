/**
 * Comprehensive test suite for telemetry.ts
 */
import assert from "node:assert";
import { logEvent, TelemetryEvent } from "../src/telemetry";

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
// logEvent Tests
// ============================================================================

async function testLogEvent() {
  console.log("\nlogEvent Tests:");

  await runTest("logEvent is a function", () => {
    assert(typeof logEvent === "function", "logEvent should be a function");
  });

  await runTest("logEvent returns a promise", () => {
    const result = logEvent({ activity_id: "test", category: "test" });
    assert(result instanceof Promise, "logEvent should return a promise");
  });

  await runTest("logEvent resolves without error for minimal event", async () => {
    await logEvent({
      activity_id: "test-activity",
      category: "memory",
    });
    // No error means success
  });

  await runTest("logEvent handles all optional fields", async () => {
    const fullEvent: TelemetryEvent = {
      activity_id: "activity-123",
      category: "language",
      domain: "fluency",
      duration_min: 2.5,
      result: "completed",
      ms: 150000,
    };
    await logEvent(fullEvent);
  });

  await runTest("logEvent handles domain field", async () => {
    await logEvent({
      activity_id: "test",
      category: "attention",
      domain: "dual-task",
    });
  });

  await runTest("logEvent handles duration_min field", async () => {
    await logEvent({
      activity_id: "test",
      category: "reminiscence",
      duration_min: 1.5,
    });
  });

  await runTest("logEvent handles result field", async () => {
    await logEvent({
      activity_id: "test",
      category: "orientation",
      result: "success",
    });
  });

  await runTest("logEvent handles ms field", async () => {
    await logEvent({
      activity_id: "test",
      category: "closing",
      ms: 60000,
    });
  });

  await runTest("logEvent handles multiple calls sequentially", async () => {
    for (let i = 0; i < 10; i++) {
      await logEvent({
        activity_id: `activity-${i}`,
        category: "test",
        ms: i * 1000,
      });
    }
  });

  await runTest("logEvent handles concurrent calls", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      activity_id: `concurrent-${i}`,
      category: "test",
    }));
    await Promise.all(events.map((e) => logEvent(e)));
  });
}

// ============================================================================
// TelemetryEvent Type Tests
// ============================================================================

async function testTelemetryEventType() {
  console.log("\nTelemetryEvent Type Tests:");

  await runTest("required fields are enforced", () => {
    // This is a compile-time check - if it compiles, the types are correct
    const event: TelemetryEvent = {
      activity_id: "required",
      category: "required",
    };
    assert(event.activity_id === "required");
    assert(event.category === "required");
  });

  await runTest("optional fields can be omitted", () => {
    const event: TelemetryEvent = {
      activity_id: "test",
      category: "test",
    };
    assert(event.domain === undefined);
    assert(event.duration_min === undefined);
    assert(event.result === undefined);
    assert(event.ms === undefined);
  });

  await runTest("all fields have correct types", () => {
    const event: TelemetryEvent = {
      activity_id: "string-id",
      category: "string-category",
      domain: "string-domain",
      duration_min: 1.5,
      result: "string-result",
      ms: 1000,
    };
    assert(typeof event.activity_id === "string");
    assert(typeof event.category === "string");
    assert(typeof event.domain === "string");
    assert(typeof event.duration_min === "number");
    assert(typeof event.result === "string");
    assert(typeof event.ms === "number");
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive Telemetry Tests");
  console.log("=".repeat(60));

  await testLogEvent();
  await testTelemetryEventType();

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
