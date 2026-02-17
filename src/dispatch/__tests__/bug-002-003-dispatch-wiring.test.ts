/**
 * BUG-002 & BUG-003: Dispatch Wiring and Error Logging Tests
 * Date: 2026-02-08 18:30 EST
 * 
 * BUG-002: Task execution blocked - scheduler never dispatches
 * BUG-003: Silent failure - no error logs when execution fails
 * 
 * Tests document expected behavior and verify fixes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockExecutor } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-002: Task Execution Blocked (P0)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug002-test-"));
    
    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
    
    executor = new MockExecutor();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-002: ready task with valid routing dispatches within one poll cycle", async () => {
    // Create task with routing
    const task = await store.create({
      title: "Test task",
      body: "Task body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Single poll should dispatch
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify executor was invoked
    expect(executor.spawned.length).toBe(1);
    expect(executor.spawned[0]?.context.taskId).toBe(task.frontmatter.id);
    expect(executor.spawned[0]?.context.agent).toBe("test-agent");

    // Verify actionsExecuted reflects actual execution
    expect(result.stats.inProgress).toBeGreaterThan(0);
    expect(events.find(e => e.type === "scheduler.poll")?.payload?.actionsExecuted).toBe(1);
  });

  it("BUG-002: task moves to in-progress directory on dispatch", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify task is in in-progress
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");

    // Verify file exists in in-progress directory
    const taskPath = join(tmpDir, "tasks", "in-progress", `${task.frontmatter.id}.md`);
    const content = await readFile(taskPath, "utf-8");
    expect(content).toContain("status: in-progress");
  });

  it("BUG-002: dispatch event logged for dispatched task", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Check for dispatch event
    const dispatchEvent = events.find(
      e => (e.type === "task.dispatch" || e.type === "action.started") && 
           e.taskId === task.frontmatter.id
    );

    expect(dispatchEvent).toBeDefined();
    expect(dispatchEvent?.taskId).toBe(task.frontmatter.id);
  });

  it("BUG-002: actionsExecuted reflects actual execution count", async () => {
    // Create 3 ready tasks
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Task ${i + 1}`,
        body: "Body",
        routing: { agent: `agent-${i + 1}` },
        createdBy: "test",
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify all 3 were executed
    expect(executor.spawned.length).toBe(3);

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(3);
    expect(pollEvent?.payload?.actionsExecuted).toBe(3);
  });

  it("BUG-002: executor missing returns graceful error", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Poll without executor
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: undefined, // No executor
    });

    // Should have reason in poll event
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(0);
    expect(pollEvent?.payload?.reason).toBeDefined();
  });

  it("BUG-002: routing prerequisites validated before dispatch", async () => {
    // Task without routing
    const task = await store.create({
      title: "No routing task",
      body: "Body",
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Should not dispatch (no routing target)
    expect(executor.spawned.length).toBe(0);

    // Should have an alert action
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBeGreaterThan(0);
  });
});

describe("BUG-003: Silent Failure - No Error Logs (P0)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let events: BaseEvent[];
  let consoleErrors: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug003-test-"));
    
    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
    
    executor = new MockExecutor();

    // Capture console.error calls
    consoleErrors = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      consoleErrors.push(args.join(" "));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-003: executor failure emits error log with reason", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "bad-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Force executor failure
    executor.setShouldFail(true, "Spawn failed: agent not found");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify error event logged
    const errorEvent = events.find(e => 
      e.type === "dispatch.error" && e.taskId === task.frontmatter.id
    );

    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload?.error).toContain("agent not found");

    // Verify console.error was called (ERROR-level log)
    expect(consoleErrors.length).toBeGreaterThan(0);
    const hasErrorLog = consoleErrors.some(msg => 
      msg.includes("ERROR") || msg.includes("error") || msg.includes("failed")
    );
    expect(hasErrorLog).toBe(true);
  });

  it("BUG-003: event log includes actionsFailed on execution failure", async () => {
    const task1 = await store.create({
      title: "Success task",
      body: "Body",
      routing: { agent: "good-agent" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    const task2 = await store.create({
      title: "Fail task",
      body: "Body",
      routing: { agent: "bad-agent" },
      createdBy: "test",
    });
    await store.transition(task2.frontmatter.id, "ready");

    // First succeeds, second fails
    let callCount = 0;
    const originalSpawn = executor.spawn.bind(executor);
    executor.spawn = vi.fn(async (context, opts) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Second spawn fails");
      }
      return originalSpawn(context, opts);
    });

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(2);
    expect(pollEvent?.payload?.actionsExecuted).toBeGreaterThan(0);

    // Should have error events for failures
    const errorEvents = events.filter(e => e.type === "dispatch.error");
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("BUG-003: failure reason includes actionable context", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "missing-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Agent 'missing-agent' not found in registry");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent?.payload?.error).toContain("missing-agent");
    expect(errorEvent?.payload?.error).toContain("not found");
  });

  it("BUG-003: error log includes task id for debugging", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Spawn timeout");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent?.taskId).toBe(task.frontmatter.id);
    expect(errorEvent?.payload?.error).toBeDefined();
  });

  it("BUG-003: multiple failures logged independently", async () => {
    // Create 3 tasks that will all fail
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Fail task ${i + 1}`,
        body: "Body",
        routing: { agent: `agent-${i + 1}` },
        createdBy: "test",
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    executor.setShouldFail(true, "All spawns fail");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Should have 3 error events
    const errorEvents = events.filter(e => e.type === "dispatch.error");
    expect(errorEvents.length).toBe(3);

    // Each should have unique task id
    const taskIds = errorEvents.map(e => e.taskId);
    expect(new Set(taskIds).size).toBe(3);
  });

  it("BUG-003: error event includes agent id when available", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "failing-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Agent error");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent?.payload?.agent).toBe("failing-agent");
  });
});
