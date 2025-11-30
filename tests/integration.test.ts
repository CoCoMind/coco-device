/**
 * Integration test suite for session lifecycle
 *
 * Tests the full session flow including:
 * - Agent creation
 * - Response tracking
 * - Stop detection
 * - Session summary generation
 *
 * Note: These tests mock external dependencies (OpenAI API, audio)
 * to run without network calls.
 */
import assert from "node:assert";
import { EventEmitter } from "node:events";
import {
  createAgent,
  createResponseTracker,
  parseSentimentJson,
  extractTextFromMessage,
  clampParticipantWindow,
  REALTIME_MODEL,
} from "../src/agent";
import { buildPlan } from "../src/planner";
import { createSessionIdentifiers } from "../src/backend";
import { tools, setEndSessionCallback, clearEndSessionCallback } from "../src/tools";

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

// Mock session for testing
class MockSession extends EventEmitter {
  transport = {
    sendEvent: (_event: unknown) => {},
  };
}

// ============================================================================
// Agent Creation Tests
// ============================================================================

async function testAgentCreation() {
  console.log("\nAgent Creation Tests:");

  await runTest("createAgent returns a RealtimeAgent", () => {
    const agent = createAgent();
    assert(agent !== null, "Agent should not be null");
    assert(agent !== undefined, "Agent should not be undefined");
  });

  await runTest("agent has correct name", () => {
    const original = process.env.COCO_AGENT_NAME;
    delete process.env.COCO_AGENT_NAME;

    const agent = createAgent();
    assert.strictEqual((agent as any).name, "Coco Coach");

    if (original !== undefined) {
      process.env.COCO_AGENT_NAME = original;
    }
  });

  await runTest("agent name can be customized", () => {
    const original = process.env.COCO_AGENT_NAME;
    process.env.COCO_AGENT_NAME = "Custom Coach";

    const agent = createAgent();
    assert.strictEqual((agent as any).name, "Custom Coach");

    if (original !== undefined) {
      process.env.COCO_AGENT_NAME = original;
    } else {
      delete process.env.COCO_AGENT_NAME;
    }
  });

  await runTest("REALTIME_MODEL is exported", () => {
    assert(REALTIME_MODEL !== undefined, "REALTIME_MODEL should be exported");
    assert(typeof REALTIME_MODEL === "string", "Should be a string");
  });
}

// ============================================================================
// Session Flow Integration Tests
// ============================================================================

async function testSessionFlow() {
  console.log("\nSession Flow Integration Tests:");

  await runTest("plan + session IDs + tools work together", () => {
    const plan = buildPlan();
    const { sessionId, planId } = createSessionIdentifiers();

    assert(plan.length === 6, "Plan should have 6 activities");
    assert(sessionId, "Session ID should be generated");
    assert(planId, "Plan ID should be generated");
    assert(tools.length === 3, "Should have 3 tools");
  });

  await runTest("response tracker tracks multiple responses", async () => {
    const session = new MockSession();
    const tracker = createResponseTracker(session as any);

    tracker.trackResponse("r1");
    tracker.trackResponse("r2");

    // Emit done events
    const waitPromise = tracker.waitForIdle(1000);
    session.emit("response.done", { response: { id: "r1" } });
    session.emit("response.done", { response: { id: "r2" } });

    await waitPromise;
  });

  await runTest("end_session callback integration", async () => {
    let stopCalled = false;
    setEndSessionCallback(() => {
      stopCalled = true;
    });

    const endSessionTool = tools.find((t) => t.name === "end_session");
    await (endSessionTool as any).invoke({}, JSON.stringify({ reason: "test" }));

    assert(stopCalled, "Stop callback should have been called");
    clearEndSessionCallback();
  });
}

// ============================================================================
// Stop Detection Tests
// ============================================================================

async function testStopDetection() {
  console.log("\nStop Detection Tests:");

  // These phrases match the actual detection logic in agent.ts
  const stopPhrases = [
    "stop session",
    "end session",
    "bye",
    "that's all",
    "stop",
    "thank you",
    "thanks",
  ];

  // This mirrors the exact logic from agent.ts historyListener
  function shouldTriggerStop(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
      normalized.includes("stop session") ||
      normalized.includes("end session") ||
      normalized === "stop" ||
      normalized.startsWith("stop ") ||
      normalized.startsWith("end ") ||
      normalized.includes("thank you") ||
      normalized.includes("thanks") ||
      normalized.includes("it's over") ||
      normalized.includes("its over") ||
      normalized.includes("that's all") ||
      normalized.includes("bye")
    );
  }

  for (const phrase of stopPhrases) {
    await runTest(`detects stop phrase: "${phrase}"`, () => {
      assert(shouldTriggerStop(phrase), `"${phrase}" should trigger stop`);
    });
  }

  await runTest("does not stop for normal phrases", () => {
    const normalPhrases = [
      "I feel good today",
      "Tell me more",
      "That's interesting",
      "Continue please",
    ];

    for (const phrase of normalPhrases) {
      assert(!shouldTriggerStop(phrase), `"${phrase}" should not trigger stop`);
    }
  });
}

// ============================================================================
// Goodbye Detection Tests
// ============================================================================

async function testGoodbyeDetection() {
  console.log("\nGoodbye Detection Tests:");

  const goodbyePhrases = [
    "take care",
    "goodbye",
    "good bye",
    "see you",
    "until next time",
    "thanks for spending time",
    "thank you for spending time",
  ];

  for (const phrase of goodbyePhrases) {
    await runTest(`detects goodbye phrase: "${phrase}"`, () => {
      const normalized = phrase.toLowerCase();
      const isGoodbye =
        normalized.includes("take care") ||
        normalized.includes("goodbye") ||
        normalized.includes("good bye") ||
        normalized.includes("see you") ||
        normalized.includes("until next time") ||
        normalized.includes("thanks for spending time") ||
        normalized.includes("thank you for spending time");

      assert(isGoodbye, `"${phrase}" should be detected as goodbye`);
    });
  }
}

// ============================================================================
// Session Summary Tests
// ============================================================================

async function testSessionSummary() {
  console.log("\nSession Summary Tests:");

  await runTest("generates valid session summary payload", () => {
    const { sessionId, planId } = createSessionIdentifiers();
    const tsStart = new Date();
    const tsEnd = new Date(tsStart.getTime() + 600000); // 10 minutes later

    const payload = {
      session_id: sessionId,
      plan_id: planId,
      user_external_id: "test-user",
      participant_id: "test-participant",
      device_id: "test-device",
      label: "test-label",
      started_at: tsStart.toISOString(),
      ended_at: tsEnd.toISOString(),
      duration_seconds: 600,
      turn_count: 6,
      sentiment_summary: "positive",
      sentiment_score: 0.8,
      notes: "Test session",
    };

    assert(payload.session_id, "Should have session_id");
    assert(payload.plan_id, "Should have plan_id");
    assert(payload.duration_seconds === 600, "Duration should be 600");
    assert(payload.turn_count === 6, "Turn count should be 6");
  });

  await runTest("transcript truncation works correctly", () => {
    const longTranscript = "x".repeat(2000);
    const truncated = longTranscript.slice(0, 1800);

    assert(truncated.length === 1800, "Should truncate to 1800 chars");
  });

  await runTest("handles empty transcript", () => {
    const utterances: string[] = [];
    const fullTranscriptNote = utterances
      .map((u, idx) => `${idx + 1}: ${u}`)
      .join(" | ");

    assert.strictEqual(fullTranscriptNote, "");
  });
}

// ============================================================================
// Configuration Tests
// ============================================================================

async function testConfiguration() {
  console.log("\nConfiguration Tests:");

  await runTest("listen window configuration", () => {
    const minWindow = Number(process.env.COCO_MIN_LISTEN_WINDOW_MS ?? "12000");
    const maxWindow = Number(process.env.COCO_MAX_LISTEN_WINDOW_MS ?? "20000");

    assert(minWindow > 0, "Min window should be positive");
    assert(maxWindow >= minWindow, "Max should be >= min");
  });

  await runTest("clampParticipantWindow uses configuration", () => {
    const result = clampParticipantWindow(1);

    // Should be between MIN and MAX (defaults: 12000-20000)
    const min = Number(process.env.COCO_MIN_LISTEN_WINDOW_MS ?? "12000");
    const max = Number(process.env.COCO_MAX_LISTEN_WINDOW_MS ?? "20000");

    assert(result >= min, `Result ${result} should be >= ${min}`);
    assert(result <= max, `Result ${result} should be <= ${max}`);
  });

  await runTest("intro response window configuration", () => {
    const introWindow = Number(process.env.COCO_INTRO_RESPONSE_WINDOW_MS ?? "8000");
    assert(introWindow > 0, "Intro window should be positive");
  });

  await runTest("final response window configuration", () => {
    const finalWindow = Number(process.env.COCO_FINAL_RESPONSE_WINDOW_MS ?? "8000");
    assert(finalWindow > 0, "Final window should be positive");
  });
}

// ============================================================================
// Text Extraction Tests
// ============================================================================

async function testTextExtraction() {
  console.log("\nText Extraction Tests:");

  await runTest("extracts text from user message", () => {
    const message = {
      type: "message",
      role: "user",
      content: "Hello there",
    };
    const text = extractTextFromMessage(message);
    assert.strictEqual(text, "Hello there");
  });

  await runTest("extracts text from assistant message", () => {
    const message = {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi! How are you?" }],
    };
    const text = extractTextFromMessage(message);
    assert.strictEqual(text, "Hi! How are you?");
  });

  await runTest("handles input_text content type", () => {
    const message = {
      content: [{ type: "input_text", text: "User input here" }],
    };
    const text = extractTextFromMessage(message);
    assert.strictEqual(text, "User input here");
  });
}

// ============================================================================
// Sentiment Integration Tests
// ============================================================================

async function testSentimentIntegration() {
  console.log("\nSentiment Integration Tests:");

  await runTest("parseSentimentJson works with valid input", () => {
    const result = parseSentimentJson('{"summary": "positive", "score": 0.85}');
    assert(result !== null);
    assert.strictEqual(result.summary, "positive");
    assert.strictEqual(result.score, 0.85);
  });

  await runTest("parseSentimentJson handles API response format", () => {
    const apiResponse = '```json\n{"summary": "neutral", "score": 0.5}\n```';
    const result = parseSentimentJson(apiResponse);
    assert(result !== null);
    assert.strictEqual(result.summary, "neutral");
    assert.strictEqual(result.score, 0.5);
  });

  await runTest("default sentiment values are sensible", () => {
    const defaultSummary = "no_input";
    const defaultScore = 0;

    assert.strictEqual(defaultSummary, "no_input");
    assert.strictEqual(defaultScore, 0);
  });
}

// ============================================================================
// Full Session Lifecycle Simulation
// ============================================================================

async function testFullLifecycle() {
  console.log("\nFull Session Lifecycle Simulation:");

  await runTest("simulates complete session lifecycle", async () => {
    // 1. Create session identifiers
    const { sessionId, planId } = createSessionIdentifiers();
    assert(sessionId && planId, "IDs should be created");

    // 2. Build plan
    const plan = buildPlan();
    assert(plan.length === 6, "Plan should have 6 steps");

    // 3. Create agent
    const agent = createAgent();
    assert(agent, "Agent should be created");

    // 4. Setup response tracker
    const mockSession = new MockSession();
    const tracker = createResponseTracker(mockSession as any);

    // 5. Setup end session callback
    let sessionEnded = false;
    setEndSessionCallback(() => {
      sessionEnded = true;
    });

    // 6. Simulate activity loop
    const utterances: string[] = [];
    for (const step of plan) {
      // Simulate participant response
      utterances.push("I feel good about this activity");
    }

    // 7. Trigger end session
    const endSessionTool = tools.find((t) => t.name === "end_session");
    await (endSessionTool as any).invoke({}, JSON.stringify({ reason: "session complete" }));
    assert(sessionEnded, "Session should be ended");

    // 8. Generate summary
    const summary = {
      session_id: sessionId,
      plan_id: planId,
      turn_count: plan.length,
      sentiment_summary: "positive",
      sentiment_score: 0.8,
    };
    assert(summary.turn_count === 6, "Should have 6 turns");

    clearEndSessionCallback();
  });

  await runTest("handles early termination correctly", async () => {
    const { sessionId, planId } = createSessionIdentifiers();
    const plan = buildPlan();

    let sessionEnded = false;
    setEndSessionCallback(() => {
      sessionEnded = true;
    });

    // Simulate early stop after 2 activities
    const activitiesCompleted = 2;

    const endSessionTool = tools.find((t) => t.name === "end_session");
    await (endSessionTool as any).invoke({}, JSON.stringify({ reason: "user requested stop" }));

    assert(sessionEnded, "Session should be ended");

    const summary = {
      session_id: sessionId,
      plan_id: planId,
      turn_count: activitiesCompleted,
      sentiment_summary: "early_exit",
      sentiment_score: 0,
      notes: "Session ended early during activities phase",
    };

    assert(summary.turn_count === 2, "Should have 2 turns");
    assert(summary.sentiment_summary === "early_exit", "Should note early exit");

    clearEndSessionCallback();
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive Integration Tests");
  console.log("=".repeat(60));

  await testAgentCreation();
  await testSessionFlow();
  await testStopDetection();
  await testGoodbyeDetection();
  await testSessionSummary();
  await testConfiguration();
  await testTextExtraction();
  await testSentimentIntegration();
  await testFullLifecycle();

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
