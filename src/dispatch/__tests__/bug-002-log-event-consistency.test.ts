/**
 * BUG-002: Scheduler Log/Event Mismatch (P2)
 * Date: 2026-02-08 19:16 EST
 * 
 * Tests verify log output and event payload are semantically consistent.
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

describe("BUG-002: Scheduler Log/Event Mismatch (P2)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let events: BaseEvent[];
  let consoleInfos: string[];
  let consoleErrors: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug002-log-test-"));
    
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

  it("BUG-002: log shows dispatched count matching event actionsExecuted", async () => {
    // Create 2 successful tasks
    for (let i = 0; i < 2; i++) {
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

    // Check event
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(2);

    // Check log
    const pollLog = consoleInfos.find(msg => msg.includes("Scheduler poll"));
    expect(pollLog).toContain("2 dispatched");
  });

  it("BUG-002: log shows failed count matching event actionsFailed", async () => {
    // Create 3 failing tasks
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Fail task ${i + 1}`,
        body: "Body",
        routing: { agent: `agent-${i + 1}` },
        createdBy: "test",
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    executor.setShouldFail(true);

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Check event
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsFailed).toBe(3);

    // Check log
    const pollLog = consoleInfos.find(msg => msg.includes("Scheduler poll"));
    expect(pollLog).toContain("3 failed");
  });

  it("BUG-002: execution_failed reason only when failures exist", async () => {
    const task = await store.create({
      title: "Fail task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true);

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // BUG-TELEMETRY-001: Reason should be "action_failed" not "execution_failed"
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.reason).toBe("action_failed");
    expect(pollEvent?.payload?.actionsFailed).toBeGreaterThan(0);

    // Log should mention failures
    const errorLog = consoleErrors.find(msg => msg.includes("failed"));
    expect(errorLog).toBeDefined();
  });

  it("BUG-002: no execution_failed when actions succeed", async () => {
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

    // Event should NOT have execution_failed reason
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.reason).not.toBe("execution_failed");
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
    expect(pollEvent?.payload?.actionsFailed).toBe(0);
  });

  it("BUG-002: mixed success and failure counts consistent", async () => {
    // Create 2 success + 1 failure
    const task1 = await store.create({
      title: "Success 1",
      body: "Body",
      routing: { agent: "agent-1" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    const task2 = await store.create({
      title: "Success 2",
      body: "Body",
      routing: { agent: "agent-2" },
      createdBy: "test",
    });
    await store.transition(task2.frontmatter.id, "ready");

    // Make one task fail by giving it an executor that fails
    const failExecutor = new MockExecutor();
    failExecutor.spawn = vi.fn().mockImplementation(async (context) => {
      if (context.agent === "agent-2") {
        return { success: false, error: "Failed" };
      }
      return { success: true, sessionId: `mock-session-${context.taskId}` };
    });

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: failExecutor,
    });

    // Event counts
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(2);
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
    expect(pollEvent?.payload?.actionsFailed).toBe(1);

    // Log counts
    const pollLog = consoleInfos.find(msg => msg.includes("Scheduler poll"));
    expect(pollLog).toContain("1 dispatched");
    expect(pollLog).toContain("1 failed");
  });

  it("BUG-002: dry-run mode log/event consistency", async () => {
    const task = await store.create({
      title: "Dry run task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true, // Dry run mode
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Event should show dry run
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.dryRun).toBe(true);
    expect(pollEvent?.payload?.actionsPlanned).toBe(1);
    expect(pollEvent?.payload?.actionsExecuted).toBe(0);
    expect(pollEvent?.payload?.reason).toBe("dry_run_mode");

    // Log should show DRY RUN
    const pollLog = consoleInfos.find(msg => msg.includes("Scheduler poll"));
    expect(pollLog).toContain("DRY RUN");
    expect(pollLog).toContain("1 actions planned");
  });

  it("BUG-002: failure reason appears in log when present", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Specific failure reason");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // BUG-TELEMETRY-001: Reason should be "action_failed" not "execution_failed"
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.reason).toBe("action_failed");

    // Log mentions failures
    const hasFailureLog = consoleErrors.some(msg => 
      msg.includes("failed") || msg.includes("failure")
    );
    expect(hasFailureLog).toBe(true);
  });

  it("BUG-002: acceptance - log and event are semantically consistent", async () => {
    // Create mixed workload: 2 success, 1 failure
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Success ${i + 1}`,
        body: "Body",
        routing: { agent: `agent-${i + 1}` },
        createdBy: "test",
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    const failTask = await store.create({
      title: "Fail task",
      body: "Body",
      routing: { agent: "fail-agent" },
      createdBy: "test",
    });
    await store.transition(failTask.frontmatter.id, "ready");

    // Custom executor that fails for fail-agent
    const customExecutor = new MockExecutor();
    customExecutor.spawn = vi.fn().mockImplementation(async (context) => {
      if (context.agent === "fail-agent") {
        return { success: false, error: "Agent unavailable" };
      }
      return { success: true, sessionId: `mock-session-${context.taskId}` };
    });

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: customExecutor,
    });

    // Event payload
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(3);
    expect(pollEvent?.payload?.actionsExecuted).toBe(2);
    expect(pollEvent?.payload?.actionsFailed).toBe(1);

    // Log output
    const pollLog = consoleInfos.find(msg => msg.includes("Scheduler poll"));
    expect(pollLog).toContain("2 dispatched");
    expect(pollLog).toContain("1 failed");

    // Failure counts match between log and event
    expect(pollEvent?.payload?.actionsFailed).toBe(1);
  });
});
