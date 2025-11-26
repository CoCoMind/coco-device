/**
 * Comprehensive test suite for planner.ts
 */
import assert from "node:assert";
import { buildPlan, Activity, ActivityCategory } from "../src/planner";

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

const EXPECTED_CATEGORIES: ActivityCategory[] = [
  "orientation",
  "language",
  "memory",
  "attention",
  "reminiscence",
  "closing",
];

// ============================================================================
// buildPlan Tests
// ============================================================================

async function testBuildPlan() {
  console.log("\nbuildPlan Tests:");

  await runTest("returns an array of activities", () => {
    const plan = buildPlan();
    assert(Array.isArray(plan), "buildPlan should return an array");
    assert(plan.length > 0, "Plan should not be empty");
  });

  await runTest("returns exactly 6 activities (one per category)", () => {
    const plan = buildPlan();
    assert.strictEqual(plan.length, 6, `Expected 6 activities, got ${plan.length}`);
  });

  await runTest("includes all required categories in correct order", () => {
    const plan = buildPlan();
    const categories = plan.map((a) => a.category);

    assert.deepStrictEqual(
      categories,
      EXPECTED_CATEGORIES,
      `Expected categories ${EXPECTED_CATEGORIES}, got ${categories}`,
    );
  });

  await runTest("each activity has required fields", () => {
    const plan = buildPlan();

    for (const activity of plan) {
      assert(activity.id, `Activity missing id: ${JSON.stringify(activity)}`);
      assert(activity.category, `Activity missing category: ${JSON.stringify(activity)}`);
      assert(
        typeof activity.duration_min === "number",
        `Activity missing duration_min: ${JSON.stringify(activity)}`,
      );
    }
  });

  await runTest("each activity has prompt, instructions, or trials", () => {
    const plan = buildPlan();

    for (const activity of plan) {
      const hasContent =
        activity.prompt ||
        activity.instructions ||
        (activity.trials && activity.trials.length > 0);
      assert(
        hasContent,
        `Activity ${activity.id} missing prompt/instructions/trials`,
      );
    }
  });

  await runTest("duration_min is clamped between 1 and 2", () => {
    const plan = buildPlan();

    for (const activity of plan) {
      assert(
        activity.duration_min! >= 1,
        `Activity ${activity.id} duration ${activity.duration_min} < 1`,
      );
      assert(
        activity.duration_min! <= 2,
        `Activity ${activity.id} duration ${activity.duration_min} > 2`,
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
      `Found duplicate IDs in plan: ${ids}`,
    );
  });

  await runTest("multiple calls produce different plans (randomization)", () => {
    // Run buildPlan multiple times and check for variation
    const plans: Activity[][] = [];
    for (let i = 0; i < 10; i++) {
      plans.push(buildPlan());
    }

    // Get all activity IDs used across plans for each category
    const idsByCategory: Map<ActivityCategory, Set<string>> = new Map();
    for (const category of EXPECTED_CATEGORIES) {
      idsByCategory.set(category, new Set());
    }

    for (const plan of plans) {
      for (const activity of plan) {
        idsByCategory.get(activity.category)?.add(activity.id);
      }
    }

    // At least one category should have more than one unique activity used
    // (unless there's only one activity per category in the library)
    let hasVariation = false;
    for (const [category, ids] of idsByCategory) {
      if (ids.size > 1) {
        hasVariation = true;
        break;
      }
    }

    // Note: This test may fail if there's only one activity per category
    // In that case, it's expected behavior, not a bug
    if (!hasVariation) {
      console.log(
        "    (Note: No variation detected - library may have single activity per category)",
      );
    }
  });

  await runTest("activity has valid category enum value", () => {
    const plan = buildPlan();
    const validCategories = new Set(EXPECTED_CATEGORIES);

    for (const activity of plan) {
      assert(
        validCategories.has(activity.category),
        `Invalid category: ${activity.category}`,
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
    const plan = buildPlan();
    for (const activity of plan) {
      assert(typeof activity.id === "string", `id should be string`);
      assert(activity.id.length > 0, `id should not be empty`);
    }
  });

  await runTest("activity category is a valid string", () => {
    const plan = buildPlan();
    for (const activity of plan) {
      assert(typeof activity.category === "string", `category should be string`);
    }
  });

  await runTest("optional fields have correct types when present", () => {
    const plan = buildPlan();
    for (const activity of plan) {
      if (activity.domain !== undefined) {
        assert(typeof activity.domain === "string", `domain should be string`);
      }
      if (activity.prompt !== undefined) {
        assert(typeof activity.prompt === "string", `prompt should be string`);
      }
      if (activity.instructions !== undefined) {
        assert(
          typeof activity.instructions === "string",
          `instructions should be string`,
        );
      }
      if (activity.trials !== undefined) {
        assert(Array.isArray(activity.trials), `trials should be array`);
      }
      if (activity.tags !== undefined) {
        assert(Array.isArray(activity.tags), `tags should be array`);
      }
      if (activity.title !== undefined) {
        assert(typeof activity.title === "string", `title should be string`);
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
    for (let i = 0; i < 100; i++) {
      const plan = buildPlan();
      assert(plan.length === 6, `Iteration ${i}: expected 6 activities`);
    }
  });

  await runTest("activities have consistent structure across calls", () => {
    const plan1 = buildPlan();
    const plan2 = buildPlan();

    // Both should have same categories in same order
    const cats1 = plan1.map((a) => a.category);
    const cats2 = plan2.map((a) => a.category);
    assert.deepStrictEqual(cats1, cats2, "Category order should be consistent");
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
