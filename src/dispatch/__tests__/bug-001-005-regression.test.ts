/**
 * BUG-001 through BUG-005 Regression Tests
 * 
 * These tests document the bugs and verify they're fixed.
 * Tests should FAIL on broken code and PASS after fixes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockAdapter } from "../executor.js";

describe("BUG-001: Scheduler Infinite Loop — Tasks Never Dispatch", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug001-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
    executor = new MockAdapter();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-001: ready task transitions to in-progress when executor is provided", async () => {
    // Create a task with routing
    const task = await store.create({
      title: "Test task",
      body: "Task body",
      priority: "normal",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });

    // Transition to ready (tasks are created in backlog by default)
    await store.transition(task.frontmatter.id, "ready");

    // Run scheduler with executor (dryRun: false)
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify task was dispatched
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions[0]?.type).toBe("assign");
    expect(executor.spawned.length).toBe(1);

    // Verify task transitioned to in-progress
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");
    expect(updatedTask?.frontmatter.lease).toBeDefined();
    expect(updatedTask?.frontmatter.lease?.agent).toBe("test-agent");
  });

  it("BUG-001: scheduler logs actionsExecuted > 0 when tasks are dispatched", async () => {
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

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify actions were executed
    expect(result.actions.length).toBe(2);
    expect(executor.spawned.length).toBe(2);

    // Check event log for scheduler.poll event with actionsExecuted
    const today = new Date().toISOString().slice(0, 10);
    const eventLog = await readFile(join(tmpDir, "events", `${today}.jsonl`), "utf-8");
    const lines = eventLog.trim().split("\n");
    const pollEvent = lines.map(l => JSON.parse(l)).find(e => e.type === "scheduler.poll");

    expect(pollEvent).toBeDefined();
    expect(pollEvent.payload.actionsExecuted).toBeGreaterThan(0);
    expect(pollEvent.payload.actionsPlanned).toBe(2);
  });

  it("BUG-001: dry-run mode does not execute actions", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true, // Dry-run mode
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Actions are planned but not executed
    expect(result.dryRun).toBe(true);
    expect(result.actions.length).toBe(1);
    expect(executor.spawned.length).toBe(0);

    // Task should still be in ready status
    const tasks = await store.list();
    const readyTask = tasks.find(t => t.frontmatter.id === task.frontmatter.id);
    expect(readyTask?.frontmatter.status).toBe("ready");
  });
});

describe("BUG-002: Missing Dispatch Events", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug002-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
    executor = new MockAdapter();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-002: dispatch.matched event is emitted when task is assigned", async () => {
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

    // Check event log for dispatch.matched
    const today = new Date().toISOString().slice(0, 10);
    const eventLog = await readFile(join(tmpDir, "events", `${today}.jsonl`), "utf-8");
    const events = eventLog.trim().split("\n").map(l => JSON.parse(l));

    const matchedEvent = events.find(e => e.type === "dispatch.matched");
    expect(matchedEvent).toBeDefined();
    expect(matchedEvent.taskId).toBe(task.frontmatter.id);
    expect(matchedEvent.payload.agent).toBe("test-agent");
    expect(matchedEvent.payload.sessionId).toBeDefined();
  });

  it("BUG-002: action.started and action.completed events are emitted", async () => {
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

    const today = new Date().toISOString().slice(0, 10);
    const eventLog = await readFile(join(tmpDir, "events", `${today}.jsonl`), "utf-8");
    const events = eventLog.trim().split("\n").map(l => JSON.parse(l));

    const startedEvent = events.find(e => e.type === "action.started");
    const completedEvent = events.find(e => e.type === "action.completed");

    expect(startedEvent).toBeDefined();
    expect(startedEvent.payload.action).toBe("assign");

    expect(completedEvent).toBeDefined();
    expect(completedEvent.payload.success).toBe(true);
  });

  it("BUG-002: dispatch.error event is emitted on spawn failure", async () => {
    executor.setShouldFail(true, "Mock spawn failure");

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

    const today = new Date().toISOString().slice(0, 10);
    const eventLog = await readFile(join(tmpDir, "events", `${today}.jsonl`), "utf-8");
    const events = eventLog.trim().split("\n").map(l => JSON.parse(l));

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.payload.error).toContain("spawn failure");
  });
});

describe("BUG-003: Misleading Scheduler Metrics", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug003-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
    executor = new MockAdapter();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-003: actionsExecuted only counts successful executions", async () => {
    // Create one successful and one failing task
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

    // First task succeeds
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    executor.clear();
    executor.setShouldFail(true);

    // Second poll with failure
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Check event logs
    const today = new Date().toISOString().slice(0, 10);
    const eventLog = await readFile(join(tmpDir, "events", `${today}.jsonl`), "utf-8");
    const events = eventLog.trim().split("\n").map(l => JSON.parse(l));
    const pollEvents = events.filter(e => e.type === "scheduler.poll");

    expect(pollEvents.length).toBe(2);

    // First poll: 2 planned, 2 executed
    expect(pollEvents[0]?.payload.actionsPlanned).toBe(2);
    expect(pollEvents[0]?.payload.actionsExecuted).toBe(2);

    // Second poll: no new ready tasks to dispatch (already in-progress)
    expect(pollEvents[1]?.payload.actionsExecuted).toBe(0);
  });

  it("BUG-003: scheduler metrics accurately reflect planned vs executed actions", async () => {
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

    const today = new Date().toISOString().slice(0, 10);
    const eventLog = await readFile(join(tmpDir, "events", `${today}.jsonl`), "utf-8");
    const events = eventLog.trim().split("\n").map(l => JSON.parse(l));
    const pollEvent = events.find(e => e.type === "scheduler.poll");

    expect(pollEvent?.payload.actionsPlanned).toBe(2);
    expect(pollEvent?.payload.actionsExecuted).toBe(2);
    expect(pollEvent?.payload.dryRun).toBe(false);
  });
});

describe("BUG-005: Zero In-Progress Tasks During Active Polling", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug005-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
    executor = new MockAdapter();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-005: at least one task exists in in-progress after dispatch", async () => {
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

    // Verify task is in in-progress status
    const tasks = await store.list();
    const inProgressTasks = tasks.filter(t => t.frontmatter.status === "in-progress");

    expect(inProgressTasks.length).toBeGreaterThan(0);
    expect(inProgressTasks[0]?.frontmatter.lease).toBeDefined();
  });

  it("BUG-005: in-progress directory contains task file", async () => {
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

    // Verify task file exists in in-progress directory
    const taskPath = join(tmpDir, "tasks", "in-progress", `${task.frontmatter.id}.md`);
    const content = await readFile(taskPath, "utf-8");

    expect(content).toContain("status: in-progress");
    expect(content).toContain("Test task");
  });

  it("BUG-005: scheduler stats show inProgress count > 0", async () => {
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

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    expect(result.stats.inProgress).toBe(2);
    expect(result.stats.ready).toBe(0);
  });
});
