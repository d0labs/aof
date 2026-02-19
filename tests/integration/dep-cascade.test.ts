/**
 * Dependency cascade integration tests (AOF-cd1e).
 *
 * Tests end-to-end cascading through the real system (no mocks):
 *   - Completion cascade: completing A immediately promotes B to ready
 *   - Multi-dep cascade: C requires both A and B done before promoting
 *   - Block cascade (opt-in): cascadeBlocks=true propagates blocked status
 *   - Block cascade (opt-out): cascadeBlocks=false (default) leaves deps untouched
 *   - Full lifecycle: A→B→C chain through complete SDLC
 *
 * Uses real FilesystemTaskStore, EventLogger, ProtocolRouter, poll() scheduler.
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
import { MockExecutor } from "../../src/dispatch/executor.js";
import { poll, resetThrottleState } from "../../src/dispatch/scheduler.js";
import { acquireLease } from "../../src/store/lease.js";
import type { ProtocolEnvelope } from "../../src/schemas/protocol.js";

// ---------------------------------------------------------------------------
// Shared test harness
// ---------------------------------------------------------------------------

describe("Dependency cascade integration (AOF-cd1e)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let router: ProtocolRouter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dep-cascade-integration-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
    executor = new MockExecutor();
    router = new ProtocolRouter({ store, logger });
    resetThrottleState();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Factories ──────────────────────────────────────────────────────────────

  function makePollConfig() {
    return {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 10,
      executor,
    };
  }

  function completionEnvelope(taskId: string): ProtocolEnvelope {
    return {
      protocol: "aof",
      version: 1,
      projectId: store.projectId,
      taskId,
      fromAgent: "test-agent",
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

  function blockedEnvelope(taskId: string): ProtocolEnvelope {
    return {
      protocol: "aof",
      version: 1,
      projectId: store.projectId,
      taskId,
      fromAgent: "test-agent",
      toAgent: "orchestrator",
      sentAt: new Date().toISOString(),
      type: "status.update",
      payload: { taskId, agentId: "test-agent", status: "blocked", blockers: ["External dep"] },
    };
  }

  /** Creates a task with routing + reviewRequired:false for simple lifecycle. */
  async function createTask(title: string, opts: { dependsOn?: string[] } = {}) {
    return store.create({
      title,
      createdBy: "ci",
      routing: { agent: "test-agent" },
      metadata: { reviewRequired: false },
      ...opts,
    });
  }

  /** Dispatches a task via poll, handling the two-cycle promote+dispatch pattern. */
  async function dispatchTask(taskId: string) {
    await poll(store, logger, makePollConfig());
    const afterPoll1 = await store.get(taskId);
    if (afterPoll1!.frontmatter.status === "ready") {
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makePollConfig());
    }
    const final = await store.get(taskId);
    expect(final!.frontmatter.status).toBe("in-progress");
  }

  /** Resets executor + throttle and runs another poll. */
  async function nextPoll() {
    executor.clear();
    resetThrottleState();
    return poll(store, logger, makePollConfig());
  }

  // =========================================================================
  // Test 1: Completion cascade — B promoted immediately when A completes
  // =========================================================================

  describe("Completion cascade", () => {
    it("promotes dependent B to ready immediately when A completes (no extra poll)", async () => {
      const taskA = await createTask("Task A");
      const taskB = await createTask("Task B — depends on A", {
        dependsOn: [taskA.frontmatter.id],
      });

      await store.transition(taskA.frontmatter.id, "ready");
      await dispatchTask(taskA.frontmatter.id);

      // B stays in backlog while A is in-progress
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("backlog");

      // Complete A via protocol router — cascade fires immediately
      await router.route(completionEnvelope(taskA.frontmatter.id));

      expect((await store.get(taskA.frontmatter.id))!.frontmatter.status).toBe("done");
      // B promoted to ready WITHOUT any additional poll
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("ready");
    });
  });

  // =========================================================================
  // Test 2: Multi-dep cascade — C needs BOTH A and B done
  // =========================================================================

  describe("Multi-dep cascade", () => {
    it("only promotes C to ready once both A and B are done", async () => {
      const taskA = await createTask("Task A");
      const taskB = await createTask("Task B");
      const taskC = await createTask("Task C — depends on A and B", {
        dependsOn: [taskA.frontmatter.id, taskB.frontmatter.id],
      });

      // Dispatch and complete A
      await store.transition(taskA.frontmatter.id, "ready");
      await dispatchTask(taskA.frontmatter.id);
      await router.route(completionEnvelope(taskA.frontmatter.id));
      expect((await store.get(taskA.frontmatter.id))!.frontmatter.status).toBe("done");

      // C still in backlog — B not done
      expect((await store.get(taskC.frontmatter.id))!.frontmatter.status).toBe("backlog");

      // Dispatch and complete B
      await store.transition(taskB.frontmatter.id, "ready");
      await nextPoll();
      const bAfterPoll = await store.get(taskB.frontmatter.id);
      if (bAfterPoll!.frontmatter.status === "ready") await nextPoll();
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("in-progress");

      await router.route(completionEnvelope(taskB.frontmatter.id));
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("done");

      // Now C should be promoted — all deps satisfied
      expect((await store.get(taskC.frontmatter.id))!.frontmatter.status).toBe("ready");
    });
  });

  // =========================================================================
  // Test 3: Block cascade (opt-in) — cascadeBlocks=true
  // =========================================================================

  describe("Block cascade (opt-in: cascadeBlocks=true)", () => {
    async function setupInProgress() {
      const taskA = await store.create({
        title: "Task A — upstream",
        createdBy: "ci",
        routing: { agent: "test-agent" },
      });
      await store.transition(taskA.frontmatter.id, "ready");
      await acquireLease(store, taskA.frontmatter.id, "test-agent", {
        writeRunArtifacts: false,
      });
      return taskA;
    }

    it("blocks backlog dependent B when upstream A is blocked", async () => {
      const cascadeRouter = new ProtocolRouter({ store, logger, cascadeBlocks: true });
      const taskA = await setupInProgress();
      const taskB = await store.create({
        title: "Task B — depends on A",
        createdBy: "ci",
        dependsOn: [taskA.frontmatter.id],
      });

      await cascadeRouter.route(blockedEnvelope(taskA.frontmatter.id));

      expect((await store.get(taskA.frontmatter.id))!.frontmatter.status).toBe("blocked");
      const bFinal = await store.get(taskB.frontmatter.id);
      expect(bFinal!.frontmatter.status).toBe("blocked");
      expect(bFinal!.frontmatter.metadata.blockReason).toContain(
        `upstream blocked: ${taskA.frontmatter.id}`,
      );
    });

    it("blocks a ready dependent when upstream A is blocked", async () => {
      const cascadeRouter = new ProtocolRouter({ store, logger, cascadeBlocks: true });
      const taskA = await setupInProgress();
      const taskB = await store.create({
        title: "Task B — ready dependent",
        createdBy: "ci",
        dependsOn: [taskA.frontmatter.id],
      });
      await store.transition(taskB.frontmatter.id, "ready");

      await cascadeRouter.route(blockedEnvelope(taskA.frontmatter.id));

      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("blocked");
    });
  });

  // =========================================================================
  // Test 4: Block cascade (opt-out default) — cascadeBlocks=false
  // =========================================================================

  describe("Block cascade (opt-out: cascadeBlocks=false, default)", () => {
    async function setupInProgress() {
      const taskA = await store.create({
        title: "Task A — upstream",
        createdBy: "ci",
        routing: { agent: "test-agent" },
      });
      await store.transition(taskA.frontmatter.id, "ready");
      await acquireLease(store, taskA.frontmatter.id, "test-agent", {
        writeRunArtifacts: false,
      });
      return taskA;
    }

    it("does NOT block backlog dependent when upstream A is blocked (default)", async () => {
      const taskA = await setupInProgress();
      const taskB = await store.create({
        title: "Task B — depends on A",
        createdBy: "ci",
        dependsOn: [taskA.frontmatter.id],
      });

      await router.route(blockedEnvelope(taskA.frontmatter.id));

      expect((await store.get(taskA.frontmatter.id))!.frontmatter.status).toBe("blocked");
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("backlog");
    });

    it("does NOT block a ready dependent when cascadeBlocks is explicitly false", async () => {
      const noCASCADE = new ProtocolRouter({ store, logger, cascadeBlocks: false });
      const taskA = await setupInProgress();
      const taskB = await store.create({
        title: "Task B — ready, depends on A",
        createdBy: "ci",
        dependsOn: [taskA.frontmatter.id],
      });
      await store.transition(taskB.frontmatter.id, "ready");

      await noCASCADE.route(blockedEnvelope(taskA.frontmatter.id));

      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("ready");
    });
  });

  // =========================================================================
  // Test 5: Full lifecycle with cascade — A→B→C dependency chain
  // =========================================================================

  describe("Full lifecycle with cascade", () => {
    it("walks A→B→C chain through complete SDLC with immediate cascade promotions", async () => {
      const taskA = await createTask("Task A — head of chain");
      const taskB = await createTask("Task B — depends on A", {
        dependsOn: [taskA.frontmatter.id],
      });
      const taskC = await createTask("Task C — depends on B", {
        dependsOn: [taskB.frontmatter.id],
      });

      // All start in backlog
      for (const t of [taskA, taskB, taskC]) {
        expect(t.frontmatter.status).toBe("backlog");
      }

      // ── Dispatch A (scheduler promotes backlog→ready, then dispatches) ─────
      const poll1 = await poll(store, logger, makePollConfig());
      const promoted = poll1.actions
        .filter((a) => a.type === "promote" && a.toStatus === "ready")
        .map((a) => a.taskId);
      expect(promoted).toContain(taskA.frontmatter.id);
      expect(promoted).not.toContain(taskB.frontmatter.id);
      expect(promoted).not.toContain(taskC.frontmatter.id);

      // If A was only promoted (not yet dispatched), one more poll dispatches it
      const aAfterPoll1 = await store.get(taskA.frontmatter.id);
      expect(["ready", "in-progress"]).toContain(aAfterPoll1!.frontmatter.status);
      if (aAfterPoll1!.frontmatter.status === "ready") await nextPoll();
      expect((await store.get(taskA.frontmatter.id))!.frontmatter.status).toBe("in-progress");

      // B and C still in backlog
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("backlog");
      expect((await store.get(taskC.frontmatter.id))!.frontmatter.status).toBe("backlog");

      // ── Complete A — B promoted immediately ───────────────────────────────
      await router.route(completionEnvelope(taskA.frontmatter.id));
      expect((await store.get(taskA.frontmatter.id))!.frontmatter.status).toBe("done");
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("ready");
      expect((await store.get(taskC.frontmatter.id))!.frontmatter.status).toBe("backlog");

      // ── Dispatch B (already ready from cascade) ───────────────────────────
      await nextPoll();
      const bAfterPoll = await store.get(taskB.frontmatter.id);
      if (bAfterPoll!.frontmatter.status === "ready") await nextPoll();
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("in-progress");

      // ── Complete B — C promoted immediately ───────────────────────────────
      await router.route(completionEnvelope(taskB.frontmatter.id));
      expect((await store.get(taskB.frontmatter.id))!.frontmatter.status).toBe("done");
      expect((await store.get(taskC.frontmatter.id))!.frontmatter.status).toBe("ready");

      // ── Dispatch C ────────────────────────────────────────────────────────
      await nextPoll();
      const cFinal = await store.get(taskC.frontmatter.id);
      expect(["ready", "in-progress"]).toContain(cFinal!.frontmatter.status);

      // Verify at least 2 dependency.cascaded events (A→B and B→C)
      const events = await logger.query({});
      const cascadeEvents = events.filter((e) => e.type === "dependency.cascaded");
      expect(cascadeEvents.length).toBeGreaterThanOrEqual(2);
    });
  });
});
