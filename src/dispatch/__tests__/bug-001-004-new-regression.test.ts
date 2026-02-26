/**
 * BUG-001 through BUG-004 Regression Tests (New Remediation Plan)
 * Date: 2026-02-08 16:42 EST
 * 
 * Tests document the NEW bugs from updated audit and verify fixes.
 * Tests should FAIL on broken code and PASS after fixes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockAdapter } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-001: Scheduler Polls But Never Executes Ready Tasks (NEW)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "new-bug001-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    
    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });
    
    executor = new MockAdapter();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-001: executor is called when ready task exists", async () => {
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

    // Verify executor was called
    expect(executor.spawned.length).toBe(1);
    expect(executor.spawned[0]?.context.taskId).toBe(task.frontmatter.id);
    expect(executor.spawned[0]?.context.agent).toBe("test-agent");
  });

  it("BUG-001: task.dispatched or action.started event is emitted", async () => {
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

    // Check for either task.dispatched or action.started
    const dispatchEvent = events.find(
      e => e.type === "task.dispatched" || e.type === "action.started"
    );
    
    expect(dispatchEvent).toBeDefined();
    expect(dispatchEvent?.taskId).toBe(task.frontmatter.id);
  });

  it("BUG-001: scheduler poll reports accurate executed count", async () => {
    const task1 = await store.create({
      title: "Task 1",
      body: "Body",
      routing: { agent: "agent-1" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    const task2 = await store.create({
      title: "Task 2",
      body: "Body",
      routing: { agent: "agent-2" },
      createdBy: "test",
    });
    await store.transition(task2.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent).toBeDefined();
    expect(pollEvent?.payload?.actionsPlanned).toBe(2);
    expect(pollEvent?.payload?.actionsExecuted).toBe(2);
  });

  it("BUG-001: ready task is dispatched within one poll cycle", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Single poll should dispatch the task
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify task was dispatched (executor called)
    expect(executor.spawned.length).toBe(1);
    
    // Verify task transitioned to in-progress
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");
  });

  it("BUG-001: dryRun=false is honored (actions execute)", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false, // Explicitly false
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify execution happened
    expect(executor.spawned.length).toBeGreaterThan(0);
    
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.dryRun).toBe(false);
    expect(pollEvent?.payload?.actionsExecuted).toBeGreaterThan(0);
  });

  it("BUG-001: dryRun=true prevents execution", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true, // Dry run
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify no execution
    expect(executor.spawned.length).toBe(0);
    
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.dryRun).toBe(true);
    expect(pollEvent?.payload?.actionsExecuted).toBe(0);
  });
});

describe("BUG-002: No Tasks Ever Reach In-Progress Status (NEW)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "new-bug002-test-"));
    
    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
    
    executor = new MockAdapter();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-002: task transitions from ready to in-progress on dispatch", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Initial state: ready
    expect((await store.get(task.frontmatter.id))?.frontmatter.status).toBe("ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // After dispatch: in-progress
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");
  });

  it("BUG-002: in-progress directory contains dispatched task", async () => {
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

    // Verify file exists in in-progress directory
    const inProgressDir = join(tmpDir, "tasks", "in-progress");
    const files = await readdir(inProgressDir);
    const taskFile = files.find(f => f.startsWith(task.frontmatter.id));

    expect(taskFile).toBeDefined();
    expect(taskFile).toContain(task.frontmatter.id);
  });

  it("BUG-002: task.transition event emitted (ready → in-progress)", async () => {
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

    const transitionEvent = events.find(e => 
      e.type === "task.transitioned" && 
      e.taskId === task.frontmatter.id
    );

    expect(transitionEvent).toBeDefined();
    expect(transitionEvent?.payload).toBeDefined();
  });

  it("BUG-002: lease is acquired on transition to in-progress", async () => {
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

    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.lease).toBeDefined();
    expect(updatedTask?.frontmatter.lease?.agent).toBe("test-agent");
    expect(updatedTask?.frontmatter.lease?.expiresAt).toBeDefined();
  });
});

describe("BUG-004: Scheduler Event Logs Missing Action Metadata (NEW)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "new-bug004-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    
    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });
    
    executor = new MockAdapter();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-004: scheduler.poll includes tasksEvaluated count", async () => {
    const task1 = await store.create({
      title: "Task 1",
      body: "Body",
      routing: { agent: "agent-1" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    const task2 = await store.create({
      title: "Task 2",
      body: "Body",
      createdBy: "test",
    });
    // task2 stays in backlog

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.tasksEvaluated).toBe(2);
  });

  it("BUG-004: scheduler.poll includes tasksReady count", async () => {
    const task1 = await store.create({
      title: "Task 1",
      body: "Body",
      routing: { agent: "agent-1" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    const task2 = await store.create({
      title: "Task 2",
      body: "Body",
      routing: { agent: "agent-2" },
      createdBy: "test",
    });
    await store.transition(task2.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.tasksReady).toBeDefined();
    // After execution, tasks are in-progress, so tasksReady should be from pre-execution snapshot
  });

  it("BUG-004: scheduler.poll includes actionsPlanned count", async () => {
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

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(1);
  });

  it("BUG-004: scheduler.poll includes actionsExecuted count", async () => {
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

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
  });

  it("BUG-004: scheduler.poll includes reason when no actions executed", async () => {
    // Create task but leave in backlog (not ready)
    await store.create({
      title: "Backlog task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(0);
    
    // Should have a reason field when no actions executed
    if (pollEvent?.payload?.actionsExecuted === 0) {
      expect(pollEvent?.payload?.reason).toBeDefined();
    }
  });

  it("BUG-004: poll logs support debugging without additional instrumentation", async () => {
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

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    
    // Verify comprehensive metadata for debugging
    expect(pollEvent?.payload?.tasksEvaluated).toBeDefined();
    expect(pollEvent?.payload?.actionsPlanned).toBeDefined();
    expect(pollEvent?.payload?.actionsExecuted).toBeDefined();
    expect(pollEvent?.payload?.stats).toBeDefined();
    expect(pollEvent?.payload?.dryRun).toBeDefined();
  });
});
