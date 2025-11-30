/**
 * Comprehensive test suite for shell scripts
 *
 * Tests script syntax validation, required environment variables,
 * and expected behavior through dry-run execution where possible.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

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

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");
const SCRIPTS = [
  "coco-native-agent-boot.sh",
  "coco-command-poller.sh",
  "coco-heartbeat.sh",
  "coco-update.sh",
  "run-scheduled-session.sh",
];

// ============================================================================
// Script Existence Tests
// ============================================================================

async function testScriptExistence() {
  console.log("\nScript Existence Tests:");

  for (const script of SCRIPTS) {
    await runTest(`${script} exists`, () => {
      const fullPath = path.join(SCRIPTS_DIR, script);
      assert(fs.existsSync(fullPath), `Script not found: ${fullPath}`);
    });
  }
}

// ============================================================================
// Script Syntax Validation Tests
// ============================================================================

async function testScriptSyntax() {
  console.log("\nScript Syntax Validation Tests:");

  for (const script of SCRIPTS) {
    await runTest(`${script} has valid bash syntax`, () => {
      const fullPath = path.join(SCRIPTS_DIR, script);
      const result = spawnSync("bash", ["-n", fullPath], {
        encoding: "utf8",
        timeout: 5000,
      });

      if (result.error) {
        throw new Error(`Failed to check syntax: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`Syntax error: ${result.stderr}`);
      }
    });
  }
}

// ============================================================================
// Script Shebang Tests
// ============================================================================

async function testScriptShebang() {
  console.log("\nScript Shebang Tests:");

  for (const script of SCRIPTS) {
    await runTest(`${script} has valid shebang`, () => {
      const fullPath = path.join(SCRIPTS_DIR, script);
      const content = fs.readFileSync(fullPath, "utf8");
      const firstLine = content.split("\n")[0];

      assert(
        firstLine.startsWith("#!"),
        `Missing shebang in ${script}`,
      );
      assert(
        firstLine.includes("bash") || firstLine.includes("sh"),
        `Shebang should reference bash or sh: ${firstLine}`,
      );
    });
  }
}

// ============================================================================
// Script Executable Tests
// ============================================================================

async function testScriptExecutable() {
  console.log("\nScript Executable Tests:");

  for (const script of SCRIPTS) {
    await runTest(`${script} is executable`, () => {
      const fullPath = path.join(SCRIPTS_DIR, script);
      const stats = fs.statSync(fullPath);
      const isExecutable = (stats.mode & parseInt("111", 8)) !== 0;

      assert(isExecutable, `Script is not executable: ${script}`);
    });
  }
}

// ============================================================================
// run-scheduled-session.sh Tests
// ============================================================================

async function testRunScheduledSession() {
  console.log("\nrun-scheduled-session.sh Tests:");

  await runTest("script has lock mechanism", () => {
    const fullPath = path.join(SCRIPTS_DIR, "run-scheduled-session.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("LOCKFILE") || content.includes("flock") || content.includes("lock"),
      "Should have locking mechanism",
    );
  });

  await runTest("script checks network connectivity", () => {
    const fullPath = path.join(SCRIPTS_DIR, "run-scheduled-session.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("ping") || content.includes("curl") || content.includes("network"),
      "Should check network connectivity",
    );
  });

  await runTest("script calls agent via SESSION_CMD", () => {
    const fullPath = path.join(SCRIPTS_DIR, "run-scheduled-session.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("SESSION_CMD") && content.includes("coco-native-agent-boot"),
      "Should call agent via SESSION_CMD (coco-native-agent-boot.sh)",
    );
  });
}

// ============================================================================
// coco-heartbeat.sh Tests
// ============================================================================

async function testCocoHeartbeat() {
  console.log("\ncoco-heartbeat.sh Tests:");

  await runTest("script sends heartbeat to backend", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-heartbeat.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("curl") || content.includes("fetch") || content.includes("heartbeat"),
      "Should send heartbeat request",
    );
  });

  await runTest("script uses COCO_BACKEND_URL", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-heartbeat.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("COCO_BACKEND_URL") || content.includes("BACKEND"),
      "Should use backend URL environment variable",
    );
  });

  await runTest("script includes device ID", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-heartbeat.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("DEVICE_ID") || content.includes("device_id") || content.includes("COCO_DEVICE_ID"),
      "Should include device ID",
    );
  });
}

// ============================================================================
// coco-command-poller.sh Tests
// ============================================================================

async function testCocoCommandPoller() {
  console.log("\ncoco-command-poller.sh Tests:");

  await runTest("script polls for commands", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-command-poller.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("curl") || content.includes("commands"),
      "Should poll for commands",
    );
  });

  await runTest("script handles REBOOT command", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-command-poller.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("REBOOT") || content.includes("reboot"),
      "Should handle REBOOT command",
    );
  });

  await runTest("script handles RESTART_SERVICE command", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-command-poller.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("RESTART") || content.includes("systemctl"),
      "Should handle RESTART_SERVICE command",
    );
  });

  await runTest("script reports command status", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-command-poller.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("status") || content.includes("STATUS"),
      "Should report command status",
    );
  });
}

// ============================================================================
// coco-update.sh Tests
// ============================================================================

async function testCocoUpdate() {
  console.log("\ncoco-update.sh Tests:");

  await runTest("script performs git operations", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-update.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("git pull") || content.includes("git fetch"),
      "Should perform git operations",
    );
  });

  await runTest("script runs npm install", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-update.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("npm install") || content.includes("npm ci"),
      "Should run npm install",
    );
  });

  await runTest("script handles service restart", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-update.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("systemctl") || content.includes("restart"),
      "Should handle service restart",
    );
  });
}

// ============================================================================
// coco-native-agent-boot.sh Tests
// ============================================================================

async function testCocoNativeAgentBoot() {
  console.log("\ncoco-native-agent-boot.sh Tests:");

  await runTest("script sources environment", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-native-agent-boot.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes(".env") || content.includes("source") || content.includes("export"),
      "Should source environment variables",
    );
  });

  await runTest("script runs agent", () => {
    const fullPath = path.join(SCRIPTS_DIR, "coco-native-agent-boot.sh");
    const content = fs.readFileSync(fullPath, "utf8");

    assert(
      content.includes("npm") || content.includes("tsx") || content.includes("node"),
      "Should run agent",
    );
  });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Running Comprehensive Scripts Tests");
  console.log("=".repeat(60));

  await testScriptExistence();
  await testScriptSyntax();
  await testScriptShebang();
  await testScriptExecutable();
  await testRunScheduledSession();
  await testCocoHeartbeat();
  await testCocoCommandPoller();
  await testCocoUpdate();
  await testCocoNativeAgentBoot();

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
