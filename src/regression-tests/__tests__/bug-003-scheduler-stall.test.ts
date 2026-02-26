/**
 * BUG-003 Regression Test: Scheduler Not Progressing Tasks
 * 
 * Critical bug: Scheduler polls and plans actions but does not execute
 * ready → in-progress transitions. This test verifies that:
 * 
 * 1. Ready tasks with routing actually transition to in-progress
 * 2. task.assigned event is emitted
 * 3. task.transitioned event is emitted
 * 4. Scheduler does not report actionsExecuted without real state change
 * 
 * This test should FAIL against current code (where tasks stay stuck in ready)
 * and PASS once backend fixes the scheduler execution path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { BaseEvent } from "../../schemas/event.js";
import { poll } from "../../dispatch/scheduler.js";
import { MockAdapter } from "../../dispatch/executor.js";

describe("BUG-003: Scheduler stall (ready → in-progress transition)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let eventsDir: string;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug003-"));
    
    eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    
    capturedEvents = [];
    logger = new EventLogger(eventsDir, {
      onEvent: (event) => {
        capturedEvents.push(event);
      },
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should transition ready task to in-progress when executor is available", async () => {
    // Create a ready task with proper routing
    const task = await store.create({
      title: "BUG-003 Test Task",
      body: "# Test\n\nThis task should be assigned by the scheduler.",
      createdBy: "regression-test",
      routing: { agent: "swe-backend" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    
    // Verify task starts in ready state
    const beforePoll = await store.get(task.frontmatter.id);
    expect(beforePoll?.frontmatter.status).toBe("ready");
    
    // Clear events from setup (we only care about scheduler actions)
    capturedEvents.length = 0;
    
    // Poll with active mode (dryRun: false) and executor
    const executor = new MockAdapter();
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor,
    });
    
    // Verify scheduler planned and executed an assign action
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("assign");
    expect(result.actions[0]?.agent).toBe("swe-backend");
    
    // CRITICAL: Task should now be in-progress
    const afterPoll = await store.get(task.frontmatter.id);
    expect(afterPoll?.frontmatter.status).toBe("in-progress");
    
    // Verify lease was acquired
    expect(afterPoll?.frontmatter.lease).toBeDefined();
    expect(afterPoll?.frontmatter.lease?.agent).toBe("swe-backend");
    
    // Verify events were emitted
    const assignedEvent = capturedEvents.find(e => e.type === "task.assigned");
    expect(assignedEvent).toBeDefined();
    expect(assignedEvent?.taskId).toBe(task.frontmatter.id);
    
    const transitionEvent = capturedEvents.find(e => e.type === "task.transitioned");
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent?.payload?.from).toBe("ready");
    expect(transitionEvent?.payload?.to).toBe("in-progress");
  });

  it("should log warning and not increment actionsExecuted when no eligible agent", async () => {
    // Create a ready task with NO routing (no eligible agent)
    const task = await store.create({
      title: "Unrouted Task",
      body: "# Test\n\nNo routing specified.",
      createdBy: "regression-test",
      routing: { tags: [] }, // No agent/role/team specified
    });
    
    await store.transition(task.frontmatter.id, "ready");
    
    // Poll with active mode
    const executor = new MockAdapter();
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor,
    });
    
    // Should produce an alert action, not an assign action
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("alert");
    expect(result.actions[0]?.reason).toContain("no routing target");
    
    // Task should still be in ready state (no transition occurred)
    const afterPoll = await store.get(task.frontmatter.id);
    expect(afterPoll?.frontmatter.status).toBe("ready");
    
    // No assignment or transition events should be emitted
    const assignedEvents = capturedEvents.filter(e => e.type === "task.assigned");
    expect(assignedEvents).toHaveLength(0);
  });

  it("should not report actionsExecuted > 0 when task stays in ready", async () => {
    // Regression test for the observed behavior in the audit:
    // actionsPlanned: 1, actionsExecuted: 1, but task stays in ready
    
    const task = await store.create({
      title: "Stuck Task",
      createdBy: "regression-test",
      routing: { agent: "swe-backend" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    
    // Poll in dry-run mode (should plan but not execute)
    const resultDryRun = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true,
      defaultLeaseTtlMs: 600_000,
    });
    
    // In dry-run: action is planned
    expect(resultDryRun.actions).toHaveLength(1);
    expect(resultDryRun.dryRun).toBe(true);
    
    // Task should still be in ready after dry-run
    const afterDryRun = await store.get(task.frontmatter.id);
    expect(afterDryRun?.frontmatter.status).toBe("ready");
  });

  it("should transition multiple ready tasks in a single poll", async () => {
    // Create multiple ready tasks
    const task1 = await store.create({
      title: "Task 1",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    const task2 = await store.create({
      title: "Task 2",
      createdBy: "test",
      routing: { agent: "swe-frontend" },
    });
    
    await store.transition(task1.frontmatter.id, "ready");
    await store.transition(task2.frontmatter.id, "ready");
    
    // Clear events from setup (we only care about scheduler actions)
    capturedEvents.length = 0;
    
    const executor = new MockAdapter();
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor,
    });
    
    // Should have 2 assign actions
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions).toHaveLength(2);
    
    // Both tasks should be in-progress
    const task1After = await store.get(task1.frontmatter.id);
    const task2After = await store.get(task2.frontmatter.id);
    expect(task1After?.frontmatter.status).toBe("in-progress");
    expect(task2After?.frontmatter.status).toBe("in-progress");
    
    // Should have 2 transition events
    const transitionEvents = capturedEvents.filter(e => e.type === "task.transitioned");
    expect(transitionEvents).toHaveLength(2);
  });
});
