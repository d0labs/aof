/**
 * E2E Test Suite 13: Workflow Gate Integration - End-to-End Gate Progression
 * 
 * Comprehensive integration tests that verify tasks flow through complete multi-gate workflows.
 * These tests prove the workflow engine works end-to-end with realistic scenarios.
 * 
 * Test Scenarios:
 * 1. Happy path: 4-gate workflow with sequential progression to done
 * 2. Rejection loop: code-review rejects → loops back to implement → advances to qa
 * 3. Blocked flow: task blocked at qa → stays → unblocked → advances
 * 4. Conditional skip: security gate with condition → task without tag skips it
 * 5. Timeout detection: task exceeds gate timeout → timeout event emitted
 * 6. Full rejection cycle with context: rejection carries notes, reviewContext visible
 * 
 * These tests use realistic Pulse SDLC workflow configs and verify:
 * - Gate transitions update task state correctly
 * - Gate history is maintained accurately
 * - Review context flows through rejection cycles
 * - Conditional gates skip appropriately
 * - Timeout escalation works
 * - Telemetry events are emitted
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { EventLogger } from "../../../src/events/logger.js";
import { handleGateTransition } from "../../../src/dispatch/gate-transition-handler.js";
import { poll } from "../../../src/dispatch/scheduler.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { serializeTask } from "../../../src/store/task-store.js";
import type { Task } from "../../../src/schemas/task.js";
import { AOFMetrics } from "../../../src/metrics/exporter.js";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "workflow-gate-integration");

/**
 * Helper: Create a task with gate workflow routing
 */
async function createGateTask(
  store: ITaskStore,
  title: string,
  workflowName: string,
  initialGate: string,
  role: string,
  tags?: string[]
): Promise<Task> {
  const task = await store.create({
    title,
    body: `# ${title}\n\nTask body content.`,
    createdBy: "system",
  });

  // Move task to review status (required for gate workflows to transition to done)
  await store.transition(task.frontmatter.id, "ready");
  await store.transition(task.frontmatter.id, "in-progress");
  await store.transition(task.frontmatter.id, "review");

  // Reload task after transitions
  const reloaded = await store.get(task.frontmatter.id);
  if (!reloaded) {
    throw new Error(`Task ${task.frontmatter.id} not found after transition`);
  }

  // Add gate routing
  reloaded.frontmatter.gate = {
    current: initialGate,
    entered: new Date().toISOString(),
  };
  reloaded.frontmatter.routing = {
    role,
    workflow: workflowName,
    tags: tags ?? [],
  };
  if (tags) {
    reloaded.frontmatter.tags = tags;
  }
  reloaded.frontmatter.gateHistory = [];

  // Write updated task
  const taskPath = join(TEST_DATA_DIR, "tasks", reloaded.frontmatter.status, `${reloaded.frontmatter.id}.md`);
  await writeFileAtomic(taskPath, serializeTask(reloaded));

  return reloaded;
}

/**
 * Helper: Complete a gate with outcome
 */
async function completeGate(
  store: ITaskStore,
  logger: EventLogger,
  taskId: string,
  outcome: "complete" | "needs_review" | "blocked",
  context: {
    summary: string;
    agent: string;
    blockers?: string[];
    rejectionNotes?: string;
  },
  metrics?: AOFMetrics
) {
  return handleGateTransition(store, logger, taskId, outcome, context, metrics);
}

/**
 * Helper: Reload task from store
 */
async function reloadTask(store: ITaskStore, taskId: string): Promise<Task> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  return task;
}

describe("E2E: Workflow Gate Integration", () => {
  let store: ITaskStore;
  let logger: EventLogger;
  let metrics: AOFMetrics;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    logger = new EventLogger(join(TEST_DATA_DIR, "events"));
    metrics = new AOFMetrics();
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("Scenario 1: Happy Path - 4-Gate Sequential Progression", () => {
    it("should progress task through implement → code-review → qa → po-accept → done", async () => {
      // Create realistic Pulse SDLC workflow
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: pulse-sdlc
  rejectionStrategy: origin
  gates:
    - id: implement
      role: swe-backend
      description: "Implement the feature with tests"
      canReject: false
    - id: code-review
      role: swe-architect
      description: "Review code quality, architecture, tests"
      canReject: true
    - id: qa
      role: swe-qa
      description: "Test the implementation"
      canReject: true
    - id: po-accept
      role: swe-po
      description: "Product owner acceptance"
      canReject: true
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      // Create task at first gate
      const task = await createGateTask(
        store,
        "Add JWT authentication",
        "pulse-sdlc",
        "implement",
        "swe-backend"
      );

      // Gate 1: Implement → Complete
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Implemented JWT middleware with tests, 85% coverage",
        agent: "backend-agent-1",
      }, metrics);

      let updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("code-review");
      expect(updated.frontmatter.routing?.role).toBe("swe-architect");
      expect(updated.frontmatter.gateHistory).toHaveLength(1);
      expect(updated.frontmatter.gateHistory?.[0]?.gate).toBe("implement");
      expect(updated.frontmatter.gateHistory?.[0]?.outcome).toBe("complete");
      expect(updated.frontmatter.reviewContext).toBeUndefined();

      // Gate 2: Code Review → Complete
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Code looks good, tests comprehensive, approved",
        agent: "architect-agent-1",
      }, metrics);

      updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("qa");
      expect(updated.frontmatter.routing?.role).toBe("swe-qa");
      expect(updated.frontmatter.gateHistory).toHaveLength(2);
      expect(updated.frontmatter.gateHistory?.[1]?.gate).toBe("code-review");
      expect(updated.frontmatter.gateHistory?.[1]?.outcome).toBe("complete");

      // Gate 3: QA → Complete
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "All test cases passed, edge cases verified",
        agent: "qa-agent-1",
      }, metrics);

      updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("po-accept");
      expect(updated.frontmatter.routing?.role).toBe("swe-po");
      expect(updated.frontmatter.gateHistory).toHaveLength(3);

      // Gate 4: PO Accept → Complete (final gate)
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Feature meets requirements, approved for release",
        agent: "po-agent-1",
      }, metrics);

      updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.status).toBe("done");
      // Gate remains set to last completed gate (provides history context)
      expect(updated.frontmatter.gate?.current).toBe("po-accept");
      expect(updated.frontmatter.gateHistory).toHaveLength(4);
      expect(updated.frontmatter.gateHistory?.[3]?.gate).toBe("po-accept");
      expect(updated.frontmatter.gateHistory?.[3]?.outcome).toBe("complete");

      // Verify all gate history entries have expected fields
      for (const entry of updated.frontmatter.gateHistory || []) {
        expect(entry.entered).toBeDefined();
        expect(entry.exited).toBeDefined();
        expect(entry.duration).toBeGreaterThanOrEqual(0);
        expect(entry.outcome).toBeDefined();
        expect(entry.summary).toBeDefined();
      }
    });
  });

  describe("Scenario 2: Rejection Loop - Needs Review Cycle", () => {
    it("should loop back to implement when code-review rejects, then advance to qa on second pass", async () => {
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: rejection-test
  rejectionStrategy: origin
  gates:
    - id: implement
      role: swe-backend
      canReject: false
    - id: code-review
      role: swe-architect
      canReject: true
    - id: qa
      role: swe-qa
      canReject: true
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      const task = await createGateTask(
        store,
        "Add validation logic",
        "rejection-test",
        "implement",
        "swe-backend"
      );

      // Gate 1: Implement → Complete (first attempt)
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Implemented validation logic",
        agent: "backend-agent-1",
      });

      let updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("code-review");

      // Gate 2: Code Review → Needs Review (rejection)
      await completeGate(store, logger, task.frontmatter.id, "needs_review", {
        summary: "Implementation needs revision",
        agent: "architect-agent-1",
        blockers: [
          "Missing edge case handling for null values",
          "Test coverage at 60%, target is 80%",
        ],
        rejectionNotes: "Please add edge case tests and improve coverage before resubmitting",
      });

      updated = await reloadTask(store, task.frontmatter.id);
      
      // Should loop back to first gate (implement)
      expect(updated.frontmatter.gate?.current).toBe("implement");
      expect(updated.frontmatter.routing?.role).toBe("swe-backend");
      expect(updated.frontmatter.gateHistory).toHaveLength(2);
      
      // Review context should be set
      expect(updated.frontmatter.reviewContext).toBeDefined();
      expect(updated.frontmatter.reviewContext?.fromGate).toBe("code-review");
      expect(updated.frontmatter.reviewContext?.fromRole).toBe("swe-architect");
      expect(updated.frontmatter.reviewContext?.fromAgent).toBe("architect-agent-1");
      expect(updated.frontmatter.reviewContext?.blockers).toHaveLength(2);
      expect(updated.frontmatter.reviewContext?.notes).toContain("edge case tests");

      // Gate 1: Implement → Complete (second attempt, with fixes)
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Fixed edge cases, added null value tests, coverage now 82%",
        agent: "backend-agent-1",
      });

      updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("code-review");
      expect(updated.frontmatter.gateHistory).toHaveLength(3);
      // Review context should be cleared on advance (not checked here, but verified in next completion)

      // Gate 2: Code Review → Complete (second pass, approved)
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "All issues addressed, tests comprehensive, approved",
        agent: "architect-agent-1",
      });

      updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("qa");
      expect(updated.frontmatter.routing?.role).toBe("swe-qa");
      expect(updated.frontmatter.gateHistory).toHaveLength(4);
      expect(updated.frontmatter.reviewContext).toBeUndefined(); // Cleared on advance

      // Verify gate history shows rejection cycle
      const history = updated.frontmatter.gateHistory || [];
      expect(history[0]?.gate).toBe("implement");
      expect(history[0]?.outcome).toBe("complete");
      expect(history[1]?.gate).toBe("code-review");
      expect(history[1]?.outcome).toBe("needs_review");
      expect(history[1]?.blockers).toHaveLength(2);
      expect(history[2]?.gate).toBe("implement");
      expect(history[2]?.outcome).toBe("complete");
      expect(history[3]?.gate).toBe("code-review");
      expect(history[3]?.outcome).toBe("complete");
    });
  });

  describe("Scenario 3: Blocked Flow - External Blocker Resolution", () => {
    it("should stay at qa when blocked, then advance when unblocked", async () => {
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: blocked-test
  rejectionStrategy: origin
  gates:
    - id: implement
      role: swe-backend
      canReject: false
    - id: qa
      role: swe-qa
      canReject: true
    - id: deploy
      role: swe-devops
      canReject: false
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      const task = await createGateTask(
        store,
        "API endpoint with database dependency",
        "blocked-test",
        "implement",
        "swe-backend"
      );

      // Gate 1: Implement → Complete
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Implemented API endpoint",
        agent: "backend-agent-1",
      });

      let updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("qa");

      // Gate 2: QA → Blocked (external dependency)
      await completeGate(store, logger, task.frontmatter.id, "blocked", {
        summary: "Cannot test without staging database",
        agent: "qa-agent-1",
        blockers: [
          "Staging database not provisioned yet",
          "Waiting for DevOps to set up test environment",
        ],
      });

      updated = await reloadTask(store, task.frontmatter.id);
      
      // Should stay in same gate
      expect(updated.frontmatter.gate?.current).toBe("qa");
      expect(updated.frontmatter.routing?.role).toBe("swe-qa");
      expect(updated.frontmatter.status).toBe("blocked");
      expect(updated.frontmatter.gateHistory).toHaveLength(2);
      expect(updated.frontmatter.gateHistory?.[1]?.gate).toBe("qa");
      expect(updated.frontmatter.gateHistory?.[1]?.outcome).toBe("blocked");
      expect(updated.frontmatter.gateHistory?.[1]?.blockers).toHaveLength(2);

      // Simulate blocker resolution (external action)
      // Task must go through ready → in-progress (valid transition path)
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      // Gate 2: QA → Complete (retry after blocker resolved)
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Staging database now available, all tests passed",
        agent: "qa-agent-1",
      });

      updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("deploy");
      expect(updated.frontmatter.routing?.role).toBe("swe-devops");
      expect(updated.frontmatter.status).toBe("in-progress");
      expect(updated.frontmatter.gateHistory).toHaveLength(3);
      
      // Verify gate history shows blocked → complete
      const history = updated.frontmatter.gateHistory || [];
      expect(history[1]?.gate).toBe("qa");
      expect(history[1]?.outcome).toBe("blocked");
      expect(history[2]?.gate).toBe("qa");
      expect(history[2]?.outcome).toBe("complete");
    });
  });

  describe("Scenario 4: Conditional Skip - Security Gate", () => {
    it("should skip security gate when task doesn't have security tag", async () => {
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: conditional-test
  rejectionStrategy: origin
  gates:
    - id: implement
      role: swe-backend
      canReject: false
    - id: security
      role: swe-security
      canReject: true
      when: "tags.includes('security')"
      description: "Security review required for security-sensitive changes"
    - id: deploy
      role: swe-devops
      canReject: false
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      // Create task WITHOUT security tag
      const task = await createGateTask(
        store,
        "Add UI component",
        "conditional-test",
        "implement",
        "swe-backend",
        ["ui", "frontend"] // No security tag
      );

      // Gate 1: Implement → Complete
      const transition = await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Implemented UI component",
        agent: "backend-agent-1",
      });

      const updated = await reloadTask(store, task.frontmatter.id);
      
      // Should skip security gate and go directly to deploy
      expect(updated.frontmatter.gate?.current).toBe("deploy");
      expect(updated.frontmatter.routing?.role).toBe("swe-devops");
      expect(transition.skipped).toContain("security");
      expect(updated.frontmatter.gateHistory).toHaveLength(1);
      expect(updated.frontmatter.gateHistory?.[0]?.gate).toBe("implement");
    });

    it("should NOT skip security gate when task has security tag", async () => {
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: conditional-test
  rejectionStrategy: origin
  gates:
    - id: implement
      role: swe-backend
      canReject: false
    - id: security
      role: swe-security
      canReject: true
      when: "tags.includes('security')"
      description: "Security review required"
    - id: deploy
      role: swe-devops
      canReject: false
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      // Create task WITH security tag
      const task = await createGateTask(
        store,
        "Add OAuth integration",
        "conditional-test",
        "implement",
        "swe-backend",
        ["auth", "security"] // Has security tag
      );

      // Gate 1: Implement → Complete
      const transition = await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Implemented OAuth flow",
        agent: "backend-agent-1",
      });

      const updated = await reloadTask(store, task.frontmatter.id);
      
      // Should NOT skip security gate
      expect(updated.frontmatter.gate?.current).toBe("security");
      expect(updated.frontmatter.routing?.role).toBe("swe-security");
      expect(transition.skipped).toHaveLength(0);
      expect(updated.frontmatter.gateHistory).toHaveLength(1);
    });
  });

  describe("Scenario 5: Timeout Detection", () => {
    it("should detect gate timeout and emit gate_timeout event", async () => {
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: timeout-test
  rejectionStrategy: origin
  gates:
    - id: review
      role: swe-architect
      timeout: "1m"
      escalateTo: swe-po
      canReject: true
`;
      const projectDir = join(TEST_DATA_DIR, "projects", "test-project");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, "project.yaml"), projectYaml);

      // Create task at gate with 1-minute timeout
      const task = await createGateTask(
        store,
        "Feature awaiting review",
        "timeout-test",
        "review",
        "swe-architect"
      );

      // Set project field so poll() can load the manifest
      task.frontmatter.project = "test-project";

      // Manually set gate entered time to 2 minutes ago (exceeds 1m timeout)
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      task.frontmatter.gate = {
        current: "review",
        entered: twoMinutesAgo,
      };
      
      // Task must be in in-progress status for scheduler to check it
      await store.transition(task.frontmatter.id, "in-progress");
      const reloaded = await store.get(task.frontmatter.id);
      if (reloaded) {
        reloaded.frontmatter.project = "test-project";
        reloaded.frontmatter.gate = {
          current: "review",
          entered: twoMinutesAgo,
        };
        await writeFileAtomic(reloaded.path!, serializeTask(reloaded));
      }

      // Run scheduler poll to detect timeout
      const config = {
        dataDir: TEST_DATA_DIR,
        dryRun: false,
        defaultLeaseTtlMs: 600_000,
      };
      const pollResult = await poll(store, logger, config);

      // Check for timeout alert action
      const alerts = pollResult.actions.filter(a => a.type === "alert");
      const timeoutAlert = alerts.find(a => 
        a.reason?.includes("timeout") && a.reason?.includes("escalated")
      );
      
      expect(timeoutAlert).toBeDefined();
      expect(timeoutAlert?.agent).toBe("swe-po");
      
      // Verify task was escalated
      const updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.routing.role).toBe("swe-po");
      
      // Verify gate history shows timeout
      expect(updated.frontmatter.gateHistory).toBeDefined();
      expect(updated.frontmatter.gateHistory!.length).toBeGreaterThan(0);
      const lastEntry = updated.frontmatter.gateHistory![updated.frontmatter.gateHistory!.length - 1];
      expect(lastEntry?.outcome).toBe("blocked");
      expect(lastEntry?.summary).toContain("Timeout");
    });
  });

  describe("Scenario 6: Full Rejection Cycle with Review Context", () => {
    it("should carry rejection notes through cycle, implementer sees reviewContext", async () => {
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: context-test
  rejectionStrategy: origin
  gates:
    - id: implement
      role: swe-backend
      canReject: false
    - id: review
      role: swe-architect
      canReject: true
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      const task = await createGateTask(
        store,
        "Add caching layer",
        "context-test",
        "implement",
        "swe-backend"
      );

      // Cycle 1: Implement → Complete
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Implemented Redis caching",
        agent: "backend-agent-1",
      });

      let updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("review");

      // Cycle 1: Review → Needs Review (first rejection)
      await completeGate(store, logger, task.frontmatter.id, "needs_review", {
        summary: "Implementation has issues",
        agent: "architect-agent-1",
        blockers: [
          "Cache invalidation logic is incorrect",
          "Missing TTL configuration",
          "No error handling for Redis connection failures",
        ],
        rejectionNotes: "The cache invalidation needs to handle cascading updates. Also add retry logic for Redis failures.",
      });

      updated = await reloadTask(store, task.frontmatter.id);
      
      // Verify reviewContext is set with full details
      expect(updated.frontmatter.gate?.current).toBe("implement");
      expect(updated.frontmatter.reviewContext).toBeDefined();
      expect(updated.frontmatter.reviewContext?.fromGate).toBe("review");
      expect(updated.frontmatter.reviewContext?.fromAgent).toBe("architect-agent-1");
      expect(updated.frontmatter.reviewContext?.fromRole).toBe("swe-architect");
      expect(updated.frontmatter.reviewContext?.blockers).toHaveLength(3);
      expect(updated.frontmatter.reviewContext?.blockers).toContain("Cache invalidation logic is incorrect");
      expect(updated.frontmatter.reviewContext?.notes).toContain("cascading updates");
      expect(updated.frontmatter.reviewContext?.notes).toContain("retry logic");
      
      // Store the rejection timestamp for later verification
      const rejectionTimestamp = updated.frontmatter.reviewContext?.timestamp;
      expect(rejectionTimestamp).toBeDefined();

      // Cycle 2: Implement → Complete (with fixes addressing reviewContext)
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Fixed cache invalidation with cascading updates, added TTL config, implemented Redis retry logic with exponential backoff",
        agent: "backend-agent-1",
      });

      updated = await reloadTask(store, task.frontmatter.id);
      expect(updated.frontmatter.gate?.current).toBe("review");
      
      // Cycle 2: Review → Complete (reviewer can see it was previously rejected)
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "All previous issues addressed, cache invalidation now correct, approved",
        agent: "architect-agent-1",
      });

      updated = await reloadTask(store, task.frontmatter.id);
      
      // Verify task is done and reviewContext is cleared
      expect(updated.frontmatter.status).toBe("done");
      expect(updated.frontmatter.reviewContext).toBeUndefined();
      
      // Verify full gate history shows the complete cycle
      const history = updated.frontmatter.gateHistory || [];
      expect(history).toHaveLength(4);
      
      // First implement
      expect(history[0]?.gate).toBe("implement");
      expect(history[0]?.outcome).toBe("complete");
      expect(history[0]?.agent).toBe("backend-agent-1");
      
      // First review (rejection)
      expect(history[1]?.gate).toBe("review");
      expect(history[1]?.outcome).toBe("needs_review");
      expect(history[1]?.agent).toBe("architect-agent-1");
      expect(history[1]?.blockers).toHaveLength(3);
      expect(history[1]?.rejectionNotes).toContain("cascading updates");
      
      // Second implement (fixes)
      expect(history[2]?.gate).toBe("implement");
      expect(history[2]?.outcome).toBe("complete");
      expect(history[2]?.agent).toBe("backend-agent-1");
      expect(history[2]?.summary).toContain("Fixed cache invalidation");
      
      // Second review (approval)
      expect(history[3]?.gate).toBe("review");
      expect(history[3]?.outcome).toBe("complete");
      expect(history[3]?.agent).toBe("architect-agent-1");
      expect(history[3]?.summary).toContain("All previous issues addressed");
    });
  });

  describe("Multi-Gate Workflow Metrics", () => {
    it("should record Prometheus metrics for gate transitions", async () => {
      const projectYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: architect
workflow:
  name: metrics-test
  rejectionStrategy: origin
  gates:
    - id: dev
      role: swe-backend
      canReject: false
    - id: review
      role: swe-architect
      canReject: true
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      const metricsInstance = new AOFMetrics();
      const task = await createGateTask(
        store,
        "Metrics test task",
        "metrics-test",
        "dev",
        "swe-backend"
      );

      // Complete gates with metrics tracking
      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Development complete",
        agent: "backend-agent-1",
      }, metricsInstance);

      await completeGate(store, logger, task.frontmatter.id, "complete", {
        summary: "Review approved",
        agent: "architect-agent-1",
      }, metricsInstance);

      // Verify metrics were recorded by exporting
      const metricsOutput = await metricsInstance.getMetrics();
      
      // Should contain gate duration metrics
      expect(metricsOutput).toContain("aof_gate_duration_seconds");
      expect(metricsOutput).toContain('gate="dev"');
      expect(metricsOutput).toContain('outcome="complete"');
      
      // Should contain gate transition metrics
      expect(metricsOutput).toContain("aof_gate_transitions_total");
      expect(metricsOutput).toContain('from_gate="dev"');
      expect(metricsOutput).toContain('to_gate="review"');
    });
  });
});
