/**
 * Comprehensive test suite for tools.ts
 */
import assert from "node:assert";
import {
  tools,
  setEndSessionCallback,
  clearEndSessionCallback,
} from "../src/tools";

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
// Tool Registration Tests
// ============================================================================

async function testToolRegistration() {
  console.log("\nTool Registration Tests:");

  await runTest("exports an array of tools", () => {
    assert(Array.isArray(tools), "tools should be an array");
    assert(tools.length > 0, "tools should not be empty");
  });

  await runTest("has exactly 3 tools", () => {
    assert.strictEqual(tools.length, 3, `Expected 3 tools, got ${tools.length}`);
  });

  await runTest("has curriculum_build_plan tool", () => {
    const tool = tools.find((t) => t.name === "curriculum_build_plan");
    assert(tool, "curriculum_build_plan tool not found");
    assert.strictEqual(tool.name, "curriculum_build_plan");
    assert(tool.description.includes("6-step"));
  });

  await runTest("has telemetry_log tool", () => {
    const tool = tools.find((t) => t.name === "telemetry_log");
    assert(tool, "telemetry_log tool not found");
    assert.strictEqual(tool.name, "telemetry_log");
    assert(tool.description.includes("Record"));
  });

  await runTest("has end_session tool", () => {
    const tool = tools.find((t) => t.name === "end_session");
    assert(tool, "end_session tool not found");
    assert.strictEqual(tool.name, "end_session");
    assert(tool.description.includes("End the current coaching session"));
  });

  await runTest("all tools have required properties", () => {
    for (const tool of tools) {
      assert(tool.name, `Tool missing name`);
      assert(typeof tool.name === "string", `Tool name should be string`);
      assert(tool.description, `Tool ${tool.name} missing description`);
      assert(
        typeof tool.description === "string",
        `Tool ${tool.name} description should be string`,
      );
    }
  });
}

// ============================================================================
// Tool Execution Tests
// ============================================================================

async function testToolExecution() {
  console.log("\nTool Execution Tests:");

  await runTest("curriculum_build_plan invokes and returns plan", async () => {
    const tool = tools.find((t) => t.name === "curriculum_build_plan");
    assert(tool, "curriculum_build_plan tool not found");

    // The tool uses invoke() method from @openai/agents - expects JSON string
    const result = await (tool as any).invoke({}, JSON.stringify({}));
    assert(Array.isArray(result), "Result should be an array");
    assert.strictEqual(result.length, 6, "Plan should have 6 activities");
  });

  await runTest("telemetry_log invokes and returns ok", async () => {
    const tool = tools.find((t) => t.name === "telemetry_log");
    assert(tool, "telemetry_log tool not found");

    const result = await (tool as any).invoke({}, JSON.stringify({
      activity_id: "test-activity",
      category: "test-category",
    }));
    assert(result.ok === true, "Result should have ok: true");
  });

  await runTest("telemetry_log handles all optional fields", async () => {
    const tool = tools.find((t) => t.name === "telemetry_log");
    assert(tool, "telemetry_log tool not found");

    const result = await (tool as any).invoke({}, JSON.stringify({
      activity_id: "test-activity",
      category: "memory",
      domain: "recall",
      duration_min: 2,
      result: "success",
      ms: 1500,
    }));
    assert(result.ok === true, "Result should have ok: true");
  });

  await runTest("end_session invokes and returns ok", async () => {
    const tool = tools.find((t) => t.name === "end_session");
    assert(tool, "end_session tool not found");

    const result = await (tool as any).invoke({}, JSON.stringify({}));
    assert(result.ok === true, "Result should have ok: true");
    assert.strictEqual(result.message, "Session ending");
  });

  await runTest("end_session accepts reason parameter", async () => {
    const tool = tools.find((t) => t.name === "end_session");
    assert(tool, "end_session tool not found");

    const result = await (tool as any).invoke({}, JSON.stringify({ reason: "user requested" }));
    assert(result.ok === true, "Result should have ok: true");
  });
}

// ============================================================================
// End Session Callback Tests
// ============================================================================

async function testEndSessionCallback() {
  console.log("\nEnd Session Callback Tests:");

  await runTest("setEndSessionCallback registers callback", async () => {
    let called = false;
    setEndSessionCallback(() => {
      called = true;
    });

    const tool = tools.find((t) => t.name === "end_session");
    await (tool as any).invoke({}, JSON.stringify({}));

    assert(called, "Callback should have been called");
    clearEndSessionCallback();
  });

  await runTest("clearEndSessionCallback removes callback", async () => {
    let callCount = 0;
    setEndSessionCallback(() => {
      callCount++;
    });

    const tool = tools.find((t) => t.name === "end_session");
    await (tool as any).invoke({}, JSON.stringify({}));
    assert.strictEqual(callCount, 1, "Callback should be called once");

    clearEndSessionCallback();
    await (tool as any).invoke({}, JSON.stringify({}));
    assert.strictEqual(callCount, 1, "Callback should not be called after clear");
  });

  await runTest("end_session works without callback", async () => {
    clearEndSessionCallback();

    const tool = tools.find((t) => t.name === "end_session");
    const result = await (tool as any).invoke({}, JSON.stringify({}));
    assert(result.ok === true, "Should work without callback");
  });

  await runTest("callback can be replaced", async () => {
    let firstCalled = false;
    let secondCalled = false;

    setEndSessionCallback(() => {
      firstCalled = true;
    });
    setEndSessionCallback(() => {
      secondCalled = true;
    });

    const tool = tools.find((t) => t.name === "end_session");
    await (tool as any).invoke({}, JSON.stringify({}));

    assert(!firstCalled, "First callback should not be called");
    assert(secondCalled, "Second callback should be called");
    clearEndSessionCallback();
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive Tools Tests");
  console.log("=".repeat(60));

  await testToolRegistration();
  await testToolExecution();
  await testEndSessionCallback();

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
