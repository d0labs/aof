/**
 * Layer 1 integration tests — in-process dispatch pipeline.
 *
 * Exercises the full dispatch pipeline with real modules:
 * - FilesystemTaskStore  (temp directory per test)
 * - EventLogger
 * - ProtocolRouter
 * - MockAdapter         (mock spawnAgent — no real agent sessions)
 * - poll()               (real scheduler)
 *
 * These tests validate that the modules wire together correctly after
 * the god-file refactor.  No networking, no Docker, runs in-process.
 *
 * Run: npx vitest run --config tests/integration/vitest.config.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FilesystemTaskStore } from "../../src/store/task-store.js";
import type { ITaskStore } from "../../src/store/interfaces.js";
import { EventLogger } from "../../src/events/logger.js";
import { ProtocolRouter } from "../../src/protocol/router.js";
import { MockAdapter } from "../../src/dispatch/executor.js";
import { poll, resetThrottleState } from "../../src/dispatch/scheduler.js";
import { acquireLease } from "../../src/store/lease.js";
import type { ProtocolEnvelope } from "../../src/schemas/protocol.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

describe("Dispatch pipeline integration", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let router: ProtocolRouter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dispatch-integration-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);

    executor = new MockAdapter();
    router = new ProtocolRouter({ store, logger });

    // Reset module-level throttle state between tests
    resetThrottleState();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Config factory — sensible defaults, overridable per test
  // -------------------------------------------------------------------------

  function makeConfig(
    overrides: Partial<{
      dryRun: boolean;
      defaultLeaseTtlMs: number;
      maxConcurrentDispatches: number;
      minDispatchIntervalMs: number;
      maxDispatchesPerPoll: number;
    }> = {},
  ) {
    return {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 0,   // disable throttle interval for tests
      maxDispatchesPerPoll: 10,
      executor,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Envelope builders
  // -------------------------------------------------------------------------

  function buildCompletionEnvelope(
    taskId: string,
    fromAgent: string,
    projectId: string,
  ): ProtocolEnvelope {
    return {
      protocol: "aof",
      version: 1,
      projectId,
      taskId,
      fromAgent,
      toAgent: "orchestrator",
      sentAt: new Date().toISOString(),
      type: "completion.report",
      payload: {
        outcome: "done",
        summaryRef: "outputs/summary.md",
        deliverables: [],
        tests: { total: 0, passed: 0, failed: 0 },
        blockers: [],
        notes: "Integration test: task completed",
      },
    };
  }

  function buildStatusUpdateEnvelope(
    taskId: string,
    fromAgent: string,
    projectId: string,
    status: "blocked" | "in-progress" | "review",
    extra: { blockers?: string[]; notes?: string } = {},
  ): ProtocolEnvelope {
    return {
      protocol: "aof",
      version: 1,
      projectId,
      taskId,
      fromAgent,
      toAgent: "orchestrator",
      sentAt: new Date().toISOString(),
      type: "status.update",
      payload: {
        taskId,
        agentId: fromAgent,
        status,
        blockers: extra.blockers,
        notes: extra.notes,
      },
    };
  }

  // =========================================================================
  // Test 1: Full task lifecycle
  // =========================================================================

  describe("Full task lifecycle", () => {
    it("dispatches a ready task and completes it end-to-end", async () => {
      // --- Setup -----------------------------------------------------------
      // Create task with reviewRequired: false so outcome "done" → "done"
      // (default reviewRequired=true would stop at "review")
      const task = await store.create({
        title: "E2E lifecycle task",
        createdBy: "ci",
        routing: { agent: "test-agent" },
        metadata: { reviewRequired: false },
      });

      // Manually promote to ready (simulates user or CI workflow)
      await store.transition(task.frontmatter.id, "ready");

      // --- Dispatch --------------------------------------------------------
      const result = await poll(store, logger, makeConfig());

      // Scheduler should have planned exactly one assign action
      const assignActions = result.actions.filter((a) => a.type === "assign");
      expect(assignActions).toHaveLength(1);
      expect(assignActions[0]!.agent).toBe("test-agent");
      expect(assignActions[0]!.taskId).toBe(task.frontmatter.id);

      // Task should now be in-progress with a lease
      const dispatched = await store.get(task.frontmatter.id);
      expect(dispatched).toBeDefined();
      expect(dispatched!.frontmatter.status).toBe("in-progress");
      expect(dispatched!.frontmatter.lease?.agent).toBe("test-agent");

      // MockAdapter should have been called once
      expect(executor.spawned).toHaveLength(1);
      expect(executor.spawned[0]!.context.taskId).toBe(task.frontmatter.id);
      expect(executor.spawned[0]!.context.agent).toBe("test-agent");

      // --- Agent completes -------------------------------------------------
      const completionEnvelope = buildCompletionEnvelope(
        task.frontmatter.id,
        "test-agent",       // must match lease.agent
        store.projectId,
      );
      await router.route(completionEnvelope);

      // Task should reach "done" (reviewRequired: false skips review gate)
      const completed = await store.get(task.frontmatter.id);
      expect(completed).toBeDefined();
      expect(completed!.frontmatter.status).toBe("done");

      // --- Event log validation --------------------------------------------
      const events = await logger.query({});
      const eventTypes = new Set(events.map((e) => e.type));

      // Dispatch events emitted by assign-executor
      expect(eventTypes.has("action.started")).toBe(true);
      expect(eventTypes.has("dispatch.matched")).toBe(true);
      expect(eventTypes.has("action.completed")).toBe(true);

      // State transition events
      expect(eventTypes.has("task.transitioned")).toBe(true);

      // Protocol events logged by router
      expect(eventTypes.has("protocol.message.received")).toBe(true);
      expect(eventTypes.has("task.completed")).toBe(true);

      // Events referencing our task ID
      const taskEvents = events.filter((e) => e.taskId === task.frontmatter.id);
      expect(taskEvents.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Test 2: Blocked task recovery
  // =========================================================================

  describe("Blocked task recovery", () => {
    it("recovers a blocked task after agent signals block and operator unblocks it", async () => {
      // Create + ready
      const task = await store.create({
        title: "Blockable task",
        createdBy: "ci",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Dispatch via scheduler
      await poll(store, logger, makeConfig());

      const dispatched = await store.get(task.frontmatter.id);
      expect(dispatched!.frontmatter.status).toBe("in-progress");

      // Agent sends blocked status update via protocol router
      const blockEnvelope = buildStatusUpdateEnvelope(
        task.frontmatter.id,
        "test-agent",
        store.projectId,
        "blocked",
        { blockers: ["External dependency unavailable"] },
      );
      await router.route(blockEnvelope);

      // Task should be blocked
      const blocked = await store.get(task.frontmatter.id);
      expect(blocked!.frontmatter.status).toBe("blocked");

      // Operator unblocks the task
      // store.transition("blocked" → "ready") clears the lease automatically
      await store.unblock(task.frontmatter.id);

      const unblocked = await store.get(task.frontmatter.id);
      expect(unblocked!.frontmatter.status).toBe("ready");
      // Lease must be cleared so next poll can re-dispatch
      expect(unblocked!.frontmatter.lease).toBeUndefined();

      // Re-dispatch: reset executor + throttle, then poll again
      executor.clear();
      resetThrottleState();

      await poll(store, logger, makeConfig());

      const reDispatched = await store.get(task.frontmatter.id);
      expect(reDispatched!.frontmatter.status).toBe("in-progress");
      expect(executor.spawned).toHaveLength(1);
      expect(executor.spawned[0]!.context.taskId).toBe(task.frontmatter.id);
    });
  });

  // =========================================================================
  // Test 3: Stale lease recovery
  // =========================================================================

  describe("Stale lease recovery", () => {
    it("detects an expired lease and recovers the task back to ready", async () => {
      // Create + ready
      const task = await store.create({
        title: "Stale lease task",
        createdBy: "ci",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Acquire a lease that expires in 1 ms (bypasses the scheduler executor
      // path to keep this test focused on lease expiry logic)
      await acquireLease(store, task.frontmatter.id, "test-agent", {
        ttlMs: 1,
        writeRunArtifacts: false,
      });

      // Confirm task is in-progress with the short-lived lease
      const leased = await store.get(task.frontmatter.id);
      expect(leased!.frontmatter.status).toBe("in-progress");
      expect(leased!.frontmatter.lease?.agent).toBe("test-agent");

      // Wait for the lease to expire
      await new Promise((r) => setTimeout(r, 20));

      // Poll — scheduler should detect the stale lease
      resetThrottleState();
      const result = await poll(store, logger, makeConfig());

      const expireActions = result.actions.filter((a) => a.type === "expire_lease");
      expect(expireActions).toHaveLength(1);
      expect(expireActions[0]!.taskId).toBe(task.frontmatter.id);
      expect(expireActions[0]!.agent).toBe("test-agent");

      // Task should have been recovered to ready
      const recovered = await store.get(task.frontmatter.id);
      expect(recovered!.frontmatter.status).toBe("ready");
      // Lease should be cleared
      expect(recovered!.frontmatter.lease).toBeUndefined();
    });
  });

  // =========================================================================
  // Test 4: Dependency chain
  // =========================================================================

  describe("Dependency chain", () => {
    it("keeps a dependent task in backlog until its blocker is done", async () => {
      // Create task A (no dependencies)
      const taskA = await store.create({
        title: "Task A — blocker",
        createdBy: "ci",
        routing: { agent: "test-agent" },
        metadata: { reviewRequired: false },
      });

      // Create task B that depends on A
      const taskB = await store.create({
        title: "Task B — dependent on A",
        createdBy: "ci",
        routing: { agent: "test-agent" },
        dependsOn: [taskA.frontmatter.id],
        metadata: { reviewRequired: false },
      });

      // Both tasks start in backlog
      expect(taskA.frontmatter.status).toBe("backlog");
      expect(taskB.frontmatter.status).toBe("backlog");

      // --- Poll 1: A should be promoted to ready, B should stay in backlog ---
      const poll1 = await poll(store, logger, makeConfig());

      const promotedToReady = poll1.actions.filter(
        (a) => a.type === "promote" && a.toStatus === "ready",
      );
      const aPromoted = promotedToReady.find((a) => a.taskId === taskA.frontmatter.id);
      const bPromoted = promotedToReady.find((a) => a.taskId === taskB.frontmatter.id);

      expect(aPromoted).toBeDefined();    // A has no deps → eligible
      expect(bPromoted).toBeUndefined();  // B depends on A → not eligible yet

      const aAfterPoll1 = await store.get(taskA.frontmatter.id);
      const bAfterPoll1 = await store.get(taskB.frontmatter.id);
      expect(aAfterPoll1!.frontmatter.status).toBe("ready");
      expect(bAfterPoll1!.frontmatter.status).toBe("backlog");

      // --- Poll 2: A gets dispatched (was ready at start of this poll) ------
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makeConfig());

      const aAfterPoll2 = await store.get(taskA.frontmatter.id);
      expect(aAfterPoll2!.frontmatter.status).toBe("in-progress");

      // B is still in backlog (A is not done yet)
      const bAfterPoll2 = await store.get(taskB.frontmatter.id);
      expect(bAfterPoll2!.frontmatter.status).toBe("backlog");

      // --- Complete task A via router ----------------------------------------
      const completionEnvelope = buildCompletionEnvelope(
        taskA.frontmatter.id,
        "test-agent",
        store.projectId,
      );
      await router.route(completionEnvelope);

      const aCompleted = await store.get(taskA.frontmatter.id);
      expect(aCompleted!.frontmatter.status).toBe("done");

      // --- Poll 3: B should be promoted (cascade fires at completion time) ---
      // With dep-cascader wired into the router, B is promoted to "ready"
      // immediately when A completes. Poll 3 may dispatch B → "in-progress".
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makeConfig());

      const bAfterPoll3 = await store.get(taskB.frontmatter.id);
      expect(["ready", "in-progress"]).toContain(bAfterPoll3!.frontmatter.status);

      // And B gets dispatched in the same or next poll
      // (depends on whether promotion + dispatch happen in the same cycle)
      // If still "ready", run one more poll to dispatch
      if (bAfterPoll3!.frontmatter.status === "ready") {
        executor.clear();
        resetThrottleState();
        await poll(store, logger, makeConfig());

        const bFinal = await store.get(taskB.frontmatter.id);
        expect(["ready", "in-progress"]).toContain(bFinal!.frontmatter.status);
      }
    });
  });
});
