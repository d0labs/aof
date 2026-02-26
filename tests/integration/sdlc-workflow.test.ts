/**
 * SDLC Workflow Integration Test
 *
 * Proves AOF's core value proposition: encoding complex real-world workflows as
 * deterministic, enforceable processes. This test models a complete Software
 * Development Lifecycle (SDLC) with gate-based progression, rejection loops,
 * task-type routing, and dependency enforcement.
 *
 * WORKFLOW DEFINITION
 * ────────────────────
 *   backlog → ready → in_progress → [implement gate]
 *                                        ↓
 *                              [code_review gate] ──reject──→ [implement gate]
 *                                        ↓ approve
 *                              [qa_review gate]   ──reject──→ [implement gate]
 *                                        ↓ approve (skipped for bugfix/hotfix)
 *                                      done
 *
 * TASK TYPE ROUTING (gate `when` conditions)
 * ───────────────────────────────────────────
 *   feature  → implement → code_review → qa_review → done  (all gates)
 *   bugfix   → implement → code_review → done              (qa_review skipped)
 *   hotfix   → implement → code_review → done              (qa_review skipped)
 *
 * SCENARIOS
 * ──────────
 *   A: Happy path feature   — full 3-gate lifecycle, audit trail verified
 *   B: Rejection loop       — code_review rejects → fixes → re-review → done
 *   C: Bugfix/hotfix paths  — qa_review gate skipped per task type
 *   D: Blocked w/ cascade   — block A, B stays in backlog; unblock A → B unblocked
 *   E: Concurrent mixed     — 5 tasks of 3 types, each follows its own path
 *   F: Audit trail          — events ordered, rejection notes preserved, timing present
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
import { MockAdapter } from "../../src/dispatch/executor.js";
import { ProtocolRouter } from "../../src/protocol/router.js";
import { poll, resetThrottleState } from "../../src/dispatch/scheduler.js";
import type { Task } from "../../src/schemas/task.js";
import {
  SDLC_TAGS,
  writeProjectYaml,
  createWorkflowTask,
  completeGate,
  reloadTask,
} from "./helpers/sdlc-workflow-helpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("SDLC Workflow Integration — lifecycle enforcement", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let router: ProtocolRouter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-sdlc-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);

    executor = new MockAdapter();
    router = new ProtocolRouter({ store, logger });
    resetThrottleState();

    // Make SDLC workflow available to handleGateTransition (reads project.yaml)
    await writeProjectYaml(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeSchedulerConfig(overrides: Record<string, unknown> = {}) {
    return {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 10,
      executor,
      ...overrides,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario A: Happy Path Feature
  //
  // A feature task walks the full 3-gate lifecycle:
  //   implement → code_review → qa_review → done
  //
  // Every gate transition is recorded in gateHistory so the audit trail is
  // complete, ordered, and annotated with agents, summaries, and timing.
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario A: Happy path feature — full 3-gate lifecycle", () => {
    it("walks implement → code_review → qa_review → done with full audit trail", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Add OAuth2 login", {
        tags: SDLC_TAGS.feature,
        metadata: { type: "feature" },
      });
      const taskId = task.frontmatter.id;

      // ── Gate 1: implement (developer builds feature) ──────────────────────
      await completeGate(store, logger, taskId, "complete", {
        summary: "OAuth2 middleware implemented, 90% test coverage",
        agent: "dev-agent",
      });

      let updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.gate?.current).toBe("code_review");
      expect(updated.frontmatter.routing?.role).toBe("reviewer");
      expect(updated.frontmatter.gateHistory).toHaveLength(1);
      expect(updated.frontmatter.gateHistory?.[0]?.gate).toBe("implement");
      expect(updated.frontmatter.gateHistory?.[0]?.outcome).toBe("complete");

      // ── Gate 2: code_review (reviewer approves) ───────────────────────────
      await completeGate(store, logger, taskId, "complete", {
        summary: "Architecture clean, tests comprehensive — approved",
        agent: "reviewer-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.gate?.current).toBe("qa_review");
      expect(updated.frontmatter.routing?.role).toBe("qa");
      expect(updated.frontmatter.gateHistory).toHaveLength(2);
      expect(updated.frontmatter.gateHistory?.[1]?.gate).toBe("code_review");
      expect(updated.frontmatter.gateHistory?.[1]?.outcome).toBe("complete");
      expect(updated.frontmatter.reviewContext).toBeUndefined(); // cleared on advance

      // ── Gate 3: qa_review (QA approves) → done ───────────────────────────
      await completeGate(store, logger, taskId, "complete", {
        summary: "All acceptance tests pass, edge cases covered",
        agent: "qa-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");
      expect(updated.frontmatter.gateHistory).toHaveLength(3);
      expect(updated.frontmatter.gateHistory?.[2]?.gate).toBe("qa_review");
      expect(updated.frontmatter.gateHistory?.[2]?.outcome).toBe("complete");

      // ── Audit trail: gate order matches SDLC definition ───────────────────
      const history = updated.frontmatter.gateHistory ?? [];
      expect(history.map((e) => e.gate)).toEqual(["implement", "code_review", "qa_review"]);

      for (const entry of history) {
        expect(entry.entered).toBeDefined();
        expect(entry.exited).toBeDefined();
        expect(entry.outcome).toBeDefined();
        expect(entry.summary).toBeDefined();
        expect(typeof entry.duration).toBe("number");
      }

      // Event log must contain gate transition events for this task
      const events = await logger.query({ taskId });
      const gateEvents = events.filter((e) => e.type === "gate_transition");
      expect(gateEvents.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario B: Rejection Loop
  //
  // A reviewer rejects the feature with notes. The task loops back to the
  // implement gate with rejection context intact so the developer knows exactly
  // what to fix. After fixing and re-submitting, the full path completes.
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario B: Rejection loop — code_review rejects, task loops back", () => {
    it("preserves rejection context on loop-back, then completes on second pass", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Add payment gateway", {
        tags: SDLC_TAGS.feature,
        metadata: { type: "feature" },
      });
      const taskId = task.frontmatter.id;

      // ── Pass 1: implement → code_review ───────────────────────────────────
      await completeGate(store, logger, taskId, "complete", {
        summary: "Payment gateway integrated, initial tests passing",
        agent: "dev-agent",
      });

      // ── code_review REJECTS with notes ────────────────────────────────────
      const rejectionNotes = "Error handling is incomplete — payment failures must be retried";
      await completeGate(store, logger, taskId, "needs_review", {
        summary: "Sending back — error handling missing",
        agent: "reviewer-agent",
        blockers: ["missing error handling", "no retry logic for transient failures"],
        rejectionNotes,
      });

      let updated = await reloadTask(store, taskId);

      // Task must loop back to implement gate (origin rejection strategy)
      expect(updated.frontmatter.gate?.current).toBe("implement");
      expect(updated.frontmatter.routing?.role).toBe("developer");

      // Full rejection context preserved for the developer to act on
      expect(updated.frontmatter.reviewContext).toBeDefined();
      expect(updated.frontmatter.reviewContext?.fromGate).toBe("code_review");
      expect(updated.frontmatter.reviewContext?.fromAgent).toBe("reviewer-agent");
      expect(updated.frontmatter.reviewContext?.fromRole).toBe("reviewer");
      expect(updated.frontmatter.reviewContext?.blockers).toContain("missing error handling");
      expect(updated.frontmatter.reviewContext?.notes).toContain("retried");

      // Gate history captures the rejection in order
      expect(updated.frontmatter.gateHistory).toHaveLength(2);
      expect(updated.frontmatter.gateHistory?.[1]?.gate).toBe("code_review");
      expect(updated.frontmatter.gateHistory?.[1]?.outcome).toBe("needs_review");
      expect(updated.frontmatter.gateHistory?.[1]?.blockers).toHaveLength(2);
      expect(updated.frontmatter.gateHistory?.[1]?.rejectionNotes).toContain("retried");

      // ── Pass 2: implement (fixes applied) → code_review → qa_review ───────
      await completeGate(store, logger, taskId, "complete", {
        summary: "Added error handling with exponential-backoff retry; all tests pass",
        agent: "dev-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.gate?.current).toBe("code_review");

      await completeGate(store, logger, taskId, "complete", {
        summary: "All issues addressed — approved",
        agent: "reviewer-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.gate?.current).toBe("qa_review");
      expect(updated.frontmatter.reviewContext).toBeUndefined(); // cleared on advance

      await completeGate(store, logger, taskId, "complete", {
        summary: "Payment flows verified end-to-end",
        agent: "qa-agent",
      });

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");

      // Full rejection history is preserved in the audit trail
      const history = updated.frontmatter.gateHistory ?? [];
      expect(history).toHaveLength(5);
      expect(history.map((e) => e.gate)).toEqual([
        "implement", "code_review", "implement", "code_review", "qa_review",
      ]);
      expect(history.map((e) => e.outcome)).toEqual([
        "complete", "needs_review", "complete", "complete", "complete",
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario C: Bugfix / Hotfix Fast Path
  //
  // Bugfix and hotfix tasks carry the "skip-qa" tag. The qa_review gate has a
  // `when` condition that evaluates to false for this tag, so the gate is skipped
  // and the task reaches done directly after code_review.
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario C: Bugfix/hotfix fast path — qa_review gate skipped", () => {
    it("routes bugfix through implement → code_review → done (no qa_review)", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Fix null pointer in auth handler", {
        tags: SDLC_TAGS.bugfix,
        metadata: { type: "bugfix" },
      });
      const taskId = task.frontmatter.id;

      await completeGate(store, logger, taskId, "complete", {
        summary: "Null check added, regression test included",
        agent: "dev-agent",
      });

      let updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.gate?.current).toBe("code_review");

      // code_review approves → qa_review is conditionally SKIPPED → done
      const transition = await completeGate(store, logger, taskId, "complete", {
        summary: "Simple null guard — approved",
        agent: "reviewer-agent",
      });

      expect(transition.skipped).toContain("qa_review");

      updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");

      // Audit trail shows the shorter 2-gate path
      const history = updated.frontmatter.gateHistory ?? [];
      expect(history).toHaveLength(2);
      expect(history.map((e) => e.gate)).toEqual(["implement", "code_review"]);
      expect(history.find((e) => e.gate === "qa_review")).toBeUndefined();
    });

    it("routes hotfix (also skip-qa tagged) through the same fast path", async () => {
      const task = await createWorkflowTask(store, tmpDir, "HOTFIX: auth regression in prod", {
        tags: SDLC_TAGS.hotfix,
        metadata: { type: "hotfix", priority: "critical" },
      });
      const taskId = task.frontmatter.id;

      await completeGate(store, logger, taskId, "complete", {
        summary: "Regression patched",
        agent: "dev-agent",
      });
      const transition = await completeGate(store, logger, taskId, "complete", {
        summary: "Hotfix verified — approved",
        agent: "reviewer-agent",
      });

      expect(transition.skipped).toContain("qa_review");

      const updated = await reloadTask(store, taskId);
      expect(updated.frontmatter.status).toBe("done");
      expect(updated.frontmatter.gateHistory).toHaveLength(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario D: Blocked Task with Cascading Impact
  //
  // Task A is blocked externally. Task B depends on A.
  // While A is blocked, B cannot proceed (its dependency is not "done").
  // Once A is unblocked, dispatched, and completed, the scheduler promotes B.
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario D: Blocked task with cascading impact on dependents", () => {
    it("holds dependent B in backlog while A is blocked; B unblocked when A completes", async () => {
      // Task A: no gate workflow — pure dependency gating demonstration
      const taskA = await store.create({
        title: "Design API spec for payments",
        createdBy: "sdlc-test",
        routing: { agent: "test-agent" },
        metadata: { reviewRequired: false },
      });

      // Task B: depends on A — must wait for A to reach "done"
      const taskB = await store.create({
        title: "Implement payments API endpoint",
        createdBy: "sdlc-test",
        routing: { agent: "test-agent" },
        dependsOn: [taskA.frontmatter.id],
        metadata: { reviewRequired: false },
      });

      expect(taskA.frontmatter.status).toBe("backlog");
      expect(taskB.frontmatter.status).toBe("backlog");

      // ── Block A (backlog → blocked) ───────────────────────────────────────
      await store.block(taskA.frontmatter.id, "waiting for API spec from design team");
      const blockedA = await store.get(taskA.frontmatter.id);
      expect(blockedA?.frontmatter.status).toBe("blocked");

      // ── Poll: B must stay in backlog (A is not done) ──────────────────────
      const pollWhileBlocked = await poll(store, logger, makeSchedulerConfig());
      const bPromotedEarly = pollWhileBlocked.actions.filter(
        (a) => a.type === "promote" && a.taskId === taskB.frontmatter.id,
      );
      expect(bPromotedEarly).toHaveLength(0);
      expect((await store.get(taskB.frontmatter.id))?.frontmatter.status).toBe("backlog");

      // ── Unblock A (blocked → ready) ───────────────────────────────────────
      await store.unblock(taskA.frontmatter.id);
      expect((await store.get(taskA.frontmatter.id))?.frontmatter.status).toBe("ready");

      // ── Dispatch A ────────────────────────────────────────────────────────
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makeSchedulerConfig());

      const inProgressA = await store.get(taskA.frontmatter.id);
      expect(inProgressA?.frontmatter.status).toBe("in-progress");

      // ── Complete A via protocol router ────────────────────────────────────
      await router.route({
        protocol: "aof",
        version: 1,
        projectId: store.projectId,
        taskId: taskA.frontmatter.id,
        fromAgent: inProgressA?.frontmatter.lease?.agent ?? "test-agent",
        toAgent: "orchestrator",
        sentAt: new Date().toISOString(),
        type: "completion.report",
        payload: {
          outcome: "done",
          summaryRef: "outputs/api-spec.md",
          deliverables: [],
          tests: { total: 5, passed: 5, failed: 0 },
          blockers: [],
          notes: "API spec finalized",
        },
      });

      expect((await store.get(taskA.frontmatter.id))?.frontmatter.status).toBe("done");

      // ── Poll after A completes: B promoted to ready (or already dispatched) ─
      // Cascade fires immediately when A completes via router, so B is promoted
      // to "ready" during router.route(). This poll may then dispatch B → "in-progress".
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makeSchedulerConfig());

      expect(["ready", "in-progress"]).toContain(
        (await store.get(taskB.frontmatter.id))?.frontmatter.status,
      );

      // ── B can be dispatched in the next poll ──────────────────────────────
      executor.clear();
      resetThrottleState();
      await poll(store, logger, makeSchedulerConfig());

      const bFinal = await store.get(taskB.frontmatter.id);
      expect(["ready", "in-progress"]).toContain(bFinal?.frontmatter.status);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario E: Concurrent Workflow Enforcement
  //
  // 5 tasks of mixed types are pushed through the workflow simultaneously.
  // AOF must route each task through its type-specific gate path with no
  // task skipping a gate it should have gone through.
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario E: Concurrent workflow enforcement for mixed task types", () => {
    it("routes each of 5 mixed-type tasks through its correct gate path", async () => {
      const f1 = await createWorkflowTask(store, tmpDir, "Feature: add search",
        { tags: SDLC_TAGS.feature, metadata: { type: "feature" } });
      const f2 = await createWorkflowTask(store, tmpDir, "Feature: add exports",
        { tags: SDLC_TAGS.feature, metadata: { type: "feature" } });
      const b1 = await createWorkflowTask(store, tmpDir, "Bugfix: fix login timeout",
        { tags: SDLC_TAGS.bugfix, metadata: { type: "bugfix" } });
      const b2 = await createWorkflowTask(store, tmpDir, "Bugfix: fix CSV export",
        { tags: SDLC_TAGS.bugfix, metadata: { type: "bugfix" } });
      const h1 = await createWorkflowTask(store, tmpDir, "Hotfix: prod crash on login",
        { tags: SDLC_TAGS.hotfix, metadata: { type: "hotfix", priority: "critical" } });

      const allTasks = [f1, f2, b1, b2, h1];

      // Walk all tasks to completion, verifying each follows its typed path
      for (const task of allTasks) {
        const id = task.frontmatter.id;
        const isSkipQa = task.frontmatter.routing.tags?.includes("skip-qa") ?? false;
        const taskType = task.frontmatter.metadata?.["type"] as string;

        await completeGate(store, logger, id, "complete", {
          summary: `${taskType}: implementation done`,
          agent: "dev-agent",
        });
        expect((await reloadTask(store, id)).frontmatter.gate?.current).toBe("code_review");

        const crTransition = await completeGate(store, logger, id, "complete", {
          summary: `${taskType}: code review approved`,
          agent: "reviewer-agent",
        });

        const afterCR = await reloadTask(store, id);

        if (isSkipQa) {
          // bugfix / hotfix: qa_review must be skipped → done immediately
          expect(crTransition.skipped).toContain("qa_review");
          expect(afterCR.frontmatter.status).toBe("done");
          expect(afterCR.frontmatter.gateHistory).toHaveLength(2);
        } else {
          // feature: must go through qa_review (gate not skipped)
          expect(crTransition.skipped).not.toContain("qa_review");
          expect(afterCR.frontmatter.gate?.current).toBe("qa_review");

          await completeGate(store, logger, id, "complete", {
            summary: "feature: QA approved",
            agent: "qa-agent",
          });

          const afterQA = await reloadTask(store, id);
          expect(afterQA.frontmatter.status).toBe("done");
          expect(afterQA.frontmatter.gateHistory).toHaveLength(3);
        }
      }

      // Verify invariants across all tasks
      for (const task of allTasks) {
        const final = await reloadTask(store, task.frontmatter.id);
        expect(final.frontmatter.status).toBe("done");
        const gateIds = new Set((final.frontmatter.gateHistory ?? []).map((e) => e.gate));
        // All task types must pass through these gates
        expect(gateIds.has("implement")).toBe(true);
        expect(gateIds.has("code_review")).toBe(true);
      }

      // Features must have qa_review in history; bugfix/hotfix must NOT
      const [f1f, f2f, b1f, b2f, h1f] = await Promise.all(
        allTasks.map((t) => reloadTask(store, t.frontmatter.id)),
      );
      const hasQaGate = (t: Task) =>
        (t.frontmatter.gateHistory ?? []).some((e) => e.gate === "qa_review");

      expect(hasQaGate(f1f!)).toBe(true);   // feature: qa required
      expect(hasQaGate(f2f!)).toBe(true);   // feature: qa required
      expect(hasQaGate(b1f!)).toBe(false);  // bugfix: qa skipped
      expect(hasQaGate(b2f!)).toBe(false);  // bugfix: qa skipped
      expect(hasQaGate(h1f!)).toBe(false);  // hotfix: qa skipped
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario F: Audit Trail Completeness
  //
  // AOF's gate history is the source of truth for compliance and retrospectives.
  // This verifies that every entry is chronologically ordered, annotated with
  // agent IDs and timing data, and that rejection notes are fully preserved.
  // ───────────────────────────────────────────────────────────────────────────
  describe("Scenario F: Audit trail completeness across a full rejection cycle", () => {
    it("every gate history entry has timestamps, agents, durations, and rejection notes", async () => {
      const task = await createWorkflowTask(store, tmpDir, "Feature: rebuild dashboard", {
        tags: SDLC_TAGS.feature,
        metadata: { type: "feature" },
      });
      const taskId = task.frontmatter.id;

      // Implement → code_review
      await completeGate(store, logger, taskId, "complete", {
        summary: "Dashboard rebuilt with new component library",
        agent: "dev-alice",
      });

      // code_review rejects with detailed feedback
      await completeGate(store, logger, taskId, "needs_review", {
        summary: "Several issues found",
        agent: "reviewer-bob",
        blockers: [
          "Accessibility: missing ARIA labels on interactive elements",
          "Performance: no virtualization for large datasets",
        ],
        rejectionNotes:
          "Dashboard looks good visually but needs accessibility and perf fixes before we can ship",
      });

      // Fix, re-submit, approve, QA
      await completeGate(store, logger, taskId, "complete", {
        summary: "ARIA labels added, virtual scroll implemented",
        agent: "dev-alice",
      });
      await completeGate(store, logger, taskId, "complete", {
        summary: "All issues resolved — approved",
        agent: "reviewer-bob",
      });
      await completeGate(store, logger, taskId, "complete", {
        summary: "Accessibility and perf verified with automated tools",
        agent: "qa-carol",
      });

      const finalTask = await reloadTask(store, taskId);
      expect(finalTask.frontmatter.status).toBe("done");

      const history = finalTask.frontmatter.gateHistory ?? [];
      expect(history).toHaveLength(5); // implement, reject, implement, approve, qa

      // ── Every entry must have timing data ─────────────────────────────────
      for (const entry of history) {
        expect(entry.entered).toBeDefined();
        expect(new Date(entry.entered).getTime()).toBeGreaterThan(0);
        expect(entry.exited).toBeDefined();
        expect(typeof entry.duration).toBe("number");
        expect(entry.duration).toBeGreaterThanOrEqual(0);
      }

      // ── Every entry must record the agent who processed the gate ──────────
      for (const entry of history) {
        expect(entry.agent).toBeDefined();
        expect(entry.agent!.length).toBeGreaterThan(0);
      }

      // ── History is chronologically ordered ────────────────────────────────
      for (let i = 1; i < history.length; i++) {
        const prevExited = new Date(history[i - 1]!.exited!).getTime();
        const currEntered = new Date(history[i]!.entered).getTime();
        expect(currEntered).toBeGreaterThanOrEqual(prevExited - 1); // 1ms jitter tolerance
      }

      // ── Rejection entry preserves full context ────────────────────────────
      const rejectionEntry = history.find((e) => e.outcome === "needs_review");
      expect(rejectionEntry).toBeDefined();
      expect(rejectionEntry?.gate).toBe("code_review");
      expect(rejectionEntry?.agent).toBe("reviewer-bob");
      expect(rejectionEntry?.blockers).toHaveLength(2);
      expect(rejectionEntry?.blockers).toContain("Accessibility: missing ARIA labels on interactive elements");
      expect(rejectionEntry?.rejectionNotes).toContain("accessibility and perf fixes");

      // ── Event log contains a gate_transition event per gate ───────────────
      const allEvents = await logger.query({ taskId });
      const gateEvents = allEvents.filter((e) => e.type === "gate_transition");
      expect(gateEvents.length).toBeGreaterThanOrEqual(5);
      for (const ev of gateEvents) {
        expect(ev.taskId).toBe(taskId);
      }

      // ── Gate order tells the complete SDLC story ──────────────────────────
      expect(history.map((e) => `${e.gate}:${e.outcome}`)).toEqual([
        "implement:complete",
        "code_review:needs_review", // rejection
        "implement:complete",        // re-work
        "code_review:complete",      // approval
        "qa_review:complete",        // QA sign-off → done
      ]);
    });
  });
});
