/**
 * BUG-008: in-progress directory empty — lifecycle consistency
 *
 * Root cause: Manual task completion (aof_task_complete) allowed direct
 * transitions from ready/blocked → done, bypassing in-progress.
 *
 * Fix: Enforce lifecycle guard in aof_task_complete that transitions to
 * in-progress first before done (if not already in in-progress or review).
 *
 * Acceptance criteria:
 * - in-progress/ contains files for actively running tasks
 * - Lifecycle transitions are consistent and recorded
 * - Manual completions no longer bypass lifecycle tracking
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch, aofTaskComplete } from "../aof-tools.js";
import type { ToolContext } from "../aof-tools.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-008: Lifecycle Consistency (in-progress guard)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let ctx: ToolContext;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug-008-"));
    capturedEvents = [];
    
    const eventsDir = join(tmpDir, "events");
    logger = new EventLogger(eventsDir, {
      onEvent: (event) => {
        capturedEvents.push(event);
      },
    });
    
    store = new FilesystemTaskStore(tmpDir, {
      hooks: {
        afterTransition: async (task, previousStatus) => {
          await logger.logTransition(
            task.frontmatter.id,
            previousStatus,
            task.frontmatter.status,
            "system",
            "test_hook"
          );
        },
      },
      logger,
    });
    await store.init();

    ctx = { store, logger };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-008: manual completion from ready transitions through in-progress and review", async () => {
    // 1. Create task (starts in ready)
    const dispatchResult = await aofDispatch(ctx, {
      title: "Test Task - Ready to Done",
      brief: "Should transition through in-progress and review",
      agent: "test-agent",
    });

    const taskId = dispatchResult.taskId;

    // Verify task in ready
    let task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("ready");

    // 2. Complete task directly from ready
    await aofTaskComplete(ctx, {
      taskId,
      actor: "test-agent",
      summary: "Manual completion from ready",
    });

    // 3. Verify task went through full lifecycle: ready → in-progress → review → done
    const transitions = capturedEvents.filter(e => e.type === "task.transitioned" && e.taskId === taskId);

    // Should have THREE transitions (manual) + others from hooks:
    // ready → in-progress (lifecycle guard)
    // in-progress → review (pre-done gate)
    // review → done (actual completion)
    expect(transitions.length).toBeGreaterThan(0);

    const toInProgress = transitions.find(
      t => (t.payload as any).from === "ready" && (t.payload as any).to === "in-progress"
    );
    expect(toInProgress).toBeDefined();
    expect((toInProgress?.payload as any)?.reason).toContain("manual_completion_lifecycle_guard");

    const toReview = transitions.find(
      t => (t.payload as any).from === "in-progress" && (t.payload as any).to === "review"
    );
    expect(toReview).toBeDefined();

    const toDone = transitions.find(
      t => (t.payload as any).from === "review" && (t.payload as any).to === "done"
    );
    expect(toDone).toBeDefined();

    // 4. Verify final status
    task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("done");
  });

  it("BUG-008: manual completion from blocked transitions through ready, in-progress, and review", async () => {
    // 1. Create task
    const dispatchResult = await aofDispatch(ctx, {
      title: "Test Task - Blocked to Done",
      brief: "Should transition through full lifecycle",
      agent: "test-agent",
    });

    const taskId = dispatchResult.taskId;

    // 2. Manually move to blocked
    await store.transition(taskId, "blocked", { reason: "test_setup" });

    let task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("blocked");

    // 3. Complete task from blocked
    await aofTaskComplete(ctx, {
      taskId,
      actor: "test-agent",
      summary: "Manual completion from blocked",
    });

    // 4. Verify lifecycle transitions (blocked → ready → in-progress → review → done)
    // Events captured via onEvent callback
    const transitions = capturedEvents.filter(e => e.type === "task.transitioned" && e.taskId === taskId);

    // Should have FOUR transitions:
    // blocked → ready (unblock)
    // ready → in-progress (lifecycle guard)
    // in-progress → review (pre-done gate)
    // review → done (actual completion)
    
    const unblockTransition = transitions.find(
      t => (t.payload as any).from === "blocked" && (t.payload as any).to === "ready"
    );
    expect(unblockTransition).toBeDefined();
    expect((unblockTransition?.payload as any)?.reason).toContain("unblock");

    const guardTransition = transitions.find(
      t => (t.payload as any).from === "ready" && (t.payload as any).to === "in-progress"
    );
    expect(guardTransition).toBeDefined();
    expect((guardTransition?.payload as any)?.reason).toContain("manual_completion_lifecycle_guard");

    const toReview = transitions.find(
      t => (t.payload as any).from === "in-progress" && (t.payload as any).to === "review"
    );
    expect(toReview).toBeDefined();

    const toDone = transitions.find(
      t => (t.payload as any).from === "review" && (t.payload as any).to === "done"
    );
    expect(toDone).toBeDefined();

    // 5. Verify final status
    task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("done");
  });

  it("BUG-008: manual completion from in-progress goes through review to done", async () => {
    // 1. Create task
    const dispatchResult = await aofDispatch(ctx, {
      title: "Test Task - In-Progress to Done",
      brief: "Already in-progress, should go through review",
      agent: "test-agent",
    });

    const taskId = dispatchResult.taskId;

    // 2. Manually move to in-progress
    await store.transition(taskId, "in-progress", { reason: "test_setup" });

    let task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("in-progress");

    // 3. Complete task from in-progress
    await aofTaskComplete(ctx, {
      taskId,
      actor: "test-agent",
      summary: "Completion from in-progress",
    });

    // 4. Verify transitions: in-progress → review → done
    // Events captured via onEvent callback
    const transitions = capturedEvents.filter(
      e => e.type === "task.transitioned" && e.taskId === taskId
    );

    const toReview = transitions.find(
      t => (t.payload as any).from === "in-progress" && (t.payload as any).to === "review"
    );
    expect(toReview).toBeDefined();

    const toDone = transitions.find(
      t => (t.payload as any).from === "review" && (t.payload as any).to === "done"
    );
    expect(toDone).toBeDefined();

    // 5. Verify final status
    task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("done");
  });

  it("BUG-008: manual completion from review goes directly to done", async () => {
    // 1. Create task
    const dispatchResult = await aofDispatch(ctx, {
      title: "Test Task - Review to Done",
      brief: "Already in review, should go directly to done",
      agent: "test-agent",
    });

    const taskId = dispatchResult.taskId;

    // 2. Move through lifecycle to review
    await store.transition(taskId, "in-progress", { reason: "test_setup" });
    await store.transition(taskId, "review", { reason: "test_setup" });

    let task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("review");

    // 3. Complete task from review
    await aofTaskComplete(ctx, {
      taskId,
      actor: "test-agent",
      summary: "Completion from review",
    });

    // 4. Verify single transition (no guard needed - review is valid pre-done state)
    // Events captured via onEvent callback
    const transitions = capturedEvents.filter(
      e => e.type === "task.transitioned" && 
      e.taskId === taskId &&
      (e.payload as any).from === "review" &&
      (e.payload as any).to === "done"
    );

    expect(transitions.length).toBeGreaterThanOrEqual(1);

    // 5. Verify final status
    task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("done");
  });

  it("BUG-008: completion of already-done task is idempotent", async () => {
    // 1. Create and complete task
    const dispatchResult = await aofDispatch(ctx, {
      title: "Test Task - Already Done",
      brief: "Should be idempotent",
      agent: "test-agent",
    });

    const taskId = dispatchResult.taskId;

    await store.transition(taskId, "in-progress", { reason: "test_setup" });
    await store.transition(taskId, "review", { reason: "test_setup" });
    await store.transition(taskId, "done", { reason: "test_setup" });

    let task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("done");

    // 2. Try to complete again
    await aofTaskComplete(ctx, {
      taskId,
      actor: "test-agent",
      summary: "Redundant completion",
    });

    // 3. Should still be done with no additional transitions
    task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("done");

    // Verify no extra done→done transitions
    // Events captured via onEvent callback
    const doneTransitions = capturedEvents.filter(
      e => e.type === "task.transitioned" && 
      e.taskId === taskId &&
      (e.payload as any).from === "done"
    );
    expect(doneTransitions.length).toBe(0);
  });

  it("BUG-008: lifecycle events recorded for all manual completions", async () => {
    // 1. Create task
    const dispatchResult = await aofDispatch(ctx, {
      title: "Test Task - Event Recording",
      brief: "Verify all transitions logged",
      agent: "test-agent",
    });

    const taskId = dispatchResult.taskId;

    // 2. Complete from ready
    await aofTaskComplete(ctx, {
      taskId,
      actor: "test-agent",
      summary: "Testing event recording",
    });

    // 3. Verify all lifecycle events present
    // Events captured via onEvent callback
    
    // Should have: task.created, task.transitioned (x3), task.completed
    const taskEvents = capturedEvents.filter(e => e.taskId === taskId);
    
    const created = taskEvents.filter(e => e.type === "task.created");
    expect(created.length).toBe(1);

    const transitions = taskEvents.filter(e => e.type === "task.transitioned");
    expect(transitions.length).toBeGreaterThanOrEqual(3); // ready→in-progress, in-progress→review, review→done

    const completed = taskEvents.filter(e => e.type === "task.completed");
    expect(completed.length).toBe(1);
  });
});
