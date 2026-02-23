/**
 * BUG-002: Scheduler Log/Event Mismatch (P2)
 * Date: 2026-02-08 19:16 EST
 *
 * Tests verify scheduler.poll event payload is semantically consistent across scenarios.
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

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug002-log-test-"));

    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });

    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();

    executor = new MockExecutor();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-002: poll event actionsExecuted matches dispatch count", async () => {
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

    // ODD: assert on scheduler.poll event payload
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(2);
    expect(pollEvent?.payload?.actionsFailed).toBe(0);
  });

  it("BUG-002: poll event actionsFailed matches failure count", async () => {
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

    // ODD: assert on event payload, not console text
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsFailed).toBe(3);
    expect(pollEvent?.payload?.actionsExecuted).toBe(0);
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

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.reason).not.toBe("execution_failed");
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
    expect(pollEvent?.payload?.actionsFailed).toBe(0);
  });

  it("BUG-002: mixed success and failure counts consistent", async () => {
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

    // ODD: event payload is the single source of truth
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(2);
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
    expect(pollEvent?.payload?.actionsFailed).toBe(1);
  });

  it("BUG-002: dry-run mode event consistency", async () => {
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

    // ODD: scheduler.poll event records dry-run state
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.dryRun).toBe(true);
    expect(pollEvent?.payload?.actionsPlanned).toBe(1);
    expect(pollEvent?.payload?.actionsExecuted).toBe(0);
    expect(pollEvent?.payload?.reason).toBe("dry_run_mode");
  });

  it("BUG-002: failure reason recorded in poll event", async () => {
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
    expect(pollEvent?.payload?.actionsFailed).toBeGreaterThan(0);
  });

  it("BUG-002: acceptance - event payload is consistent across mixed workloads", async () => {
    // 2 success, 1 failure
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

    // ODD: assert on event payload
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsPlanned).toBe(3);
    expect(pollEvent?.payload?.actionsExecuted).toBe(2);
    expect(pollEvent?.payload?.actionsFailed).toBe(1);

    // dispatch.error event for the failed task
    const errorEvents = events.filter(e => e.type === "dispatch.error");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0]?.payload?.error).toContain("unavailable");
  });
});
