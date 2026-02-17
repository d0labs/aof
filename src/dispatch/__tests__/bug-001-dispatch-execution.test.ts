/**
 * BUG-001: Scheduler Perpetual Execution Failure (P0)
 * Date: 2026-02-08 19:16 EST
 * 
 * Tests verify executor is invoked and execution path completes successfully.
 * Evidence: actionsPlanned:1 with actionsExecuted:0 and reason:execution_failed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockExecutor } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-001: Scheduler Perpetual Execution Failure (P0)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let events: BaseEvent[];
  let consoleInfos: string[];
  let consoleErrors: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug001-exec-test-"));
    
    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
    
    executor = new MockExecutor();

    // Capture console logs
    consoleInfos = [];
    consoleErrors = [];
    vi.spyOn(console, "info").mockImplementation((...args) => {
      consoleInfos.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      consoleErrors.push(args.join(" "));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-001: debug logging confirms executor invoked", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Test body",
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

  it("BUG-001: task transitions to in-progress on successful spawn", async () => {
    const task = await store.create({
      title: "Success task",
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

    // Task should be in-progress
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");
  });

  it("BUG-001: actionsExecuted=1 on successful spawn", async () => {
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

    // Check poll event
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(1);
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
    expect(pollEvent?.payload?.actionsFailed).toBe(0);
    expect(pollEvent?.payload?.reason).toBeUndefined();
  });

  it("BUG-001: no execution_failed reason on success", async () => {
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
    expect(pollEvent?.payload?.reason).not.toBe("execution_failed");
  });

  it("BUG-001: dispatch/start event logged on success", async () => {
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

    // Verify dispatch events
    const startEvent = events.find(e => e.type === "action.started");
    expect(startEvent).toBeDefined();
    expect(startEvent?.taskId).toBe(task.frontmatter.id);

    const matchedEvent = events.find(e => e.type === "dispatch.matched");
    expect(matchedEvent).toBeDefined();
    expect(matchedEvent?.taskId).toBe(task.frontmatter.id);

    const completedEvent = events.find(e => e.type === "action.completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload?.success).toBe(true);
  });

  it("BUG-001: acceptance - full dispatch cycle completes", async () => {
    const task = await store.create({
      title: "Acceptance test task",
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

    // Acceptance criteria:
    // 1. Task transitions ready → in-progress
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");

    // 2. Scheduler reports actionsExecuted:1 and no execution_failed
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
    expect(pollEvent?.payload?.reason).not.toBe("execution_failed");

    // 3. Event log includes dispatch/start event
    const startEvent = events.find(e => e.type === "action.started");
    expect(startEvent?.taskId).toBe(task.frontmatter.id);
  });

  it("BUG-001: console log shows dispatched count", async () => {
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

    // Verify console log shows dispatched count
    const pollLog = consoleInfos.find(msg => msg.includes("Scheduler poll"));
    expect(pollLog).toBeDefined();
    expect(pollLog).toContain("1 dispatched");
    expect(pollLog).toContain("0 failed");
  });

  it("BUG-001: executor receives correct task context", async () => {
    const task = await store.create({
      title: "Context test",
      body: "Body",
      routing: { 
        agent: "test-agent",
        tags: ["priority", "backend"],
      },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Verify context passed to executor
    expect(executor.spawned.length).toBe(1);
    const context = executor.spawned[0]?.context;
    expect(context?.taskId).toBe(task.frontmatter.id);
    expect(context?.agent).toBe("test-agent");
    expect(context?.routing.tags).toEqual(["priority", "backend"]);
    expect(context?.priority).toBeDefined();
  });
});
