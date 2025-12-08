/**
 * Comprehensive test suite for planner.ts
 *
 * Updated for research-backed cognitive domains and adaptive planning.
 */
import assert from "node:assert";
import { buildPlan, buildAdaptivePlan } from "../src/planner";
import { Activity, SessionPlan } from "../src/types/activity";
import { CognitiveDomain, TRAINABLE_DOMAINS } from "../src/types/domains";
import { createDefaultProfile } from "../src/types/profile";

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

// Valid cognitive domains for the new structure
const VALID_DOMAINS: CognitiveDomain[] = [
  "complex_attention",
  "processing_speed",
  "executive_function",
  "working_memory",
  "episodic_memory",
  "language",
  "social_cognition",
  "orientation",
  "closing",
];

// ============================================================================
// buildPlan Tests (Legacy compatibility)
// ============================================================================

async function testBuildPlan() {
  console.log("\nbuildPlan Tests (Legacy):");

  await runTest("returns an array of activities", () => {
    const plan = buildPlan();
    assert(Array.isArray(plan), "buildPlan should return an array");
    assert(plan.length > 0, "Plan should not be empty");
  });

  await runTest("each activity has required fields", () => {
    const plan = buildPlan();

    for (const activity of plan) {
      assert(activity.id, `Activity missing id: ${JSON.stringify(activity)}`);
      assert(
        activity.cognitive_domain,
        `Activity missing cognitive_domain: ${JSON.stringify(activity)}`
      );
      assert(
        typeof activity.duration_min === "number",
        `Activity missing duration_min: ${JSON.stringify(activity)}`
      );
    }
  });

  await runTest("each activity has valid cognitive domain", () => {
    const plan = buildPlan();
    const validDomains = new Set(VALID_DOMAINS);

    for (const activity of plan) {
      assert(
        validDomains.has(activity.cognitive_domain),
        `Invalid cognitive_domain: ${activity.cognitive_domain}`
      );
    }
  });

  await runTest("generates unique activity IDs (no duplicates in single plan)", () => {
    const plan = buildPlan();
    const ids = plan.map((a) => a.id);
    const uniqueIds = new Set(ids);

    assert.strictEqual(
      uniqueIds.size,
      ids.length,
      `Found duplicate IDs in plan: ${ids}`
    );
  });
}

// ============================================================================
// buildAdaptivePlan Tests
// ============================================================================

async function testBuildAdaptivePlan() {
  console.log("\nbuildAdaptivePlan Tests:");

  await runTest("returns a SessionPlan object", () => {
    const plan = buildAdaptivePlan();
    assert(plan.session_id, "Plan should have session_id");
    assert(plan.plan_id, "Plan should have plan_id");
    assert(Array.isArray(plan.activities), "Plan should have activities array");
    assert(plan.created_at, "Plan should have created_at timestamp");
  });

  await runTest("generates valid UUIDs for session and plan IDs", () => {
    const plan = buildAdaptivePlan();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert(uuidRegex.test(plan.session_id), "session_id should be valid UUID");
    assert(uuidRegex.test(plan.plan_id), "plan_id should be valid UUID");
  });

  await runTest("includes orientation at start", () => {
    const plan = buildAdaptivePlan();
    assert(plan.activities.length > 0, "Plan should have activities");
    assert.strictEqual(
      plan.activities[0].cognitive_domain,
      "orientation",
      "First activity should be orientation"
    );
  });

  await runTest("includes closing at end", () => {
    const plan = buildAdaptivePlan();
    const lastActivity = plan.activities[plan.activities.length - 1];
    assert.strictEqual(
      lastActivity.cognitive_domain,
      "closing",
      "Last activity should be closing"
    );
  });

  await runTest("includes word garden activities for delayed recall", () => {
    const plan = buildAdaptivePlan();
    const activityIds = plan.activities.map((a) => a.id);

    const hasPlant = activityIds.some((id) => id.includes("word_garden_plant"));
    const hasHarvest = activityIds.some((id) => id.includes("word_garden_harvest"));

    assert(hasPlant, "Plan should include word_garden_plant");
    assert(hasHarvest, "Plan should include word_garden_harvest");
  });

  await runTest("word_garden_harvest comes after word_garden_plant", () => {
    const plan = buildAdaptivePlan();
    const activityIds = plan.activities.map((a) => a.id);

    const plantIndex = activityIds.findIndex((id) => id.includes("word_garden_plant"));
    const harvestIndex = activityIds.findIndex((id) => id.includes("word_garden_harvest"));

    assert(plantIndex >= 0, "Should have word_garden_plant");
    assert(harvestIndex >= 0, "Should have word_garden_harvest");
    assert(
      harvestIndex > plantIndex,
      `Harvest (index ${harvestIndex}) should come after plant (index ${plantIndex})`
    );
  });

  await runTest("includes domain exercises between orientation and closing", () => {
    const plan = buildAdaptivePlan();

    // Filter out orientation, closing, and word_garden activities
    const domainExercises = plan.activities.filter(
      (a) =>
        a.cognitive_domain !== "orientation" &&
        a.cognitive_domain !== "closing" &&
        !a.id.includes("word_garden")
    );

    assert(
      domainExercises.length >= 1,
      `Plan should have at least 1 domain exercise, got ${domainExercises.length}`
    );
  });

  await runTest("all activities have valid cognitive domains", () => {
    const plan = buildAdaptivePlan();
    const validDomains = new Set(VALID_DOMAINS);

    for (const activity of plan.activities) {
      assert(
        validDomains.has(activity.cognitive_domain),
        `Invalid cognitive_domain: ${activity.cognitive_domain}`
      );
    }
  });

  await runTest("estimated_duration_min is reasonable", () => {
    const plan = buildAdaptivePlan();
    assert(
      plan.estimated_duration_min >= 10,
      `Duration ${plan.estimated_duration_min} should be >= 10 minutes`
    );
    assert(
      plan.estimated_duration_min <= 25,
      `Duration ${plan.estimated_duration_min} should be <= 25 minutes`
    );
  });

  await runTest("works with user profile", () => {
    const profile = createDefaultProfile("test-user", "test-participant");
    const plan = buildAdaptivePlan(profile);

    assert(plan.activities.length > 0, "Plan should have activities");
    assert(plan.target_domains.length > 0, "Plan should have target domains");
  });

  await runTest("target_domains are populated", () => {
    const plan = buildAdaptivePlan();
    assert(Array.isArray(plan.target_domains), "target_domains should be array");

    const trainableDomains = new Set(TRAINABLE_DOMAINS);
    for (const domain of plan.target_domains) {
      assert(
        trainableDomains.has(domain as any) ||
          domain === "orientation" ||
          domain === "closing",
        `Invalid target domain: ${domain}`
      );
    }
  });
}

// ============================================================================
// Activity Structure Tests
// ============================================================================

async function testActivityStructure() {
  console.log("\nActivity Structure Tests:");

  await runTest("activity id is a non-empty string", () => {
    const plan = buildAdaptivePlan();
    for (const activity of plan.activities) {
      assert(typeof activity.id === "string", `id should be string`);
      assert(activity.id.length > 0, `id should not be empty`);
    }
  });

  await runTest("activity cognitive_domain is a valid string", () => {
    const plan = buildAdaptivePlan();
    for (const activity of plan.activities) {
      assert(
        typeof activity.cognitive_domain === "string",
        `cognitive_domain should be string`
      );
    }
  });

  await runTest("activity has type field", () => {
    const plan = buildAdaptivePlan();
    for (const activity of plan.activities) {
      assert(activity.type, `Activity ${activity.id} missing type`);
    }
  });

  await runTest("activity has scoring configuration", () => {
    const plan = buildAdaptivePlan();
    for (const activity of plan.activities) {
      assert(activity.scoring, `Activity ${activity.id} missing scoring`);
      assert(activity.scoring.metric, `Activity ${activity.id} missing scoring.metric`);
    }
  });

  await runTest("optional fields have correct types when present", () => {
    const plan = buildAdaptivePlan();
    for (const activity of plan.activities) {
      if (activity.title !== undefined) {
        assert(typeof activity.title === "string", `title should be string`);
      }
      if (activity.description !== undefined) {
        assert(typeof activity.description === "string", `description should be string`);
      }
      if (activity.instructions !== undefined) {
        assert(typeof activity.instructions === "string", `instructions should be string`);
      }
      if (activity.script !== undefined) {
        assert(Array.isArray(activity.script), `script should be array`);
      }
      if (activity.tags !== undefined) {
        assert(Array.isArray(activity.tags), `tags should be array`);
      }
    }
  });
}

// ============================================================================
// Edge Case Tests
// ============================================================================

async function testEdgeCases() {
  console.log("\nEdge Case Tests:");

  await runTest("handles many sequential calls without error", () => {
    for (let i = 0; i < 50; i++) {
      const plan = buildAdaptivePlan();
      assert(plan.activities.length >= 5, `Iteration ${i}: expected >= 5 activities`);
    }
  });

  await runTest("generates unique session IDs across calls", () => {
    const sessionIds = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const plan = buildAdaptivePlan();
      assert(
        !sessionIds.has(plan.session_id),
        `Duplicate session_id: ${plan.session_id}`
      );
      sessionIds.add(plan.session_id);
    }
  });

  await runTest("activities have consistent structure across calls", () => {
    const plan1 = buildAdaptivePlan();
    const plan2 = buildAdaptivePlan();

    // Both should start with orientation and end with closing
    assert.strictEqual(
      plan1.activities[0].cognitive_domain,
      "orientation",
      "First should be orientation"
    );
    assert.strictEqual(
      plan2.activities[0].cognitive_domain,
      "orientation",
      "First should be orientation"
    );

    assert.strictEqual(
      plan1.activities[plan1.activities.length - 1].cognitive_domain,
      "closing",
      "Last should be closing"
    );
    assert.strictEqual(
      plan2.activities[plan2.activities.length - 1].cognitive_domain,
      "closing",
      "Last should be closing"
    );
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive Planner Tests");
  console.log("=".repeat(60));

  await testBuildPlan();
  await testBuildAdaptivePlan();
  await testActivityStructure();
  await testEdgeCases();

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
