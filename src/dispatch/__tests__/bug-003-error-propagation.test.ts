/**
 * BUG-003: No Error Propagation in Executor (P0)
 * Date: 2026-02-08 19:16 EST
 *
 * Tests verify executor errors produce dispatch.error events with actionable context.
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

describe("BUG-003: No Error Propagation in Executor (P0)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug003-err-test-"));

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

  it("BUG-003: executor spawn failure produces dispatch.error event", async () => {
    const task = await store.create({
      title: "Failing task",
      body: "Body",
      routing: { agent: "bad-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Agent not found in registry");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // ODD: dispatch.error event is the observable signal of failure
    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.taskId).toBe(task.frontmatter.id);
  });

  it("BUG-003: dispatch.error event includes actionable context", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Spawn timeout after 30s");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // ODD: error details are in the event payload, not console text
    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.taskId).toBe(task.frontmatter.id);
    expect(errorEvent?.payload?.error).toContain("timeout");

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsFailed).toBe(1);
  });

  it("BUG-003: error event includes error message", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Connection timeout");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.taskId).toBe(task.frontmatter.id);
    expect(errorEvent?.payload?.error).toContain("timeout");
  });

  it("BUG-003: executor exception produces dispatch.error event", async () => {
    const task = await store.create({
      title: "Exception task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldThrow(true);

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // ODD: exception is captured in dispatch.error event
    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.taskId).toBe(task.frontmatter.id);
  });

  it("BUG-003: exception error includes stack/message in event", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldThrow(true);

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload?.error).toContain("exception");
  });

  it("BUG-003: action.completed event includes error on failure", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Test error");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const completedEvent = events.find(e => e.type === "action.completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload?.success).toBe(false);
    expect(completedEvent?.payload?.error).toBeDefined();
  });

  it("BUG-003: multiple failures each produce independent dispatch.error events", async () => {
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Fail task ${i + 1}`,
        body: "Body",
        routing: { agent: `agent-${i + 1}` },
        createdBy: "test",
      });
      await store.transition(task.frontmatter.id, "ready");
      tasks.push(task);
    }

    executor.setShouldFail(true);

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // ODD: one dispatch.error per failing task
    const errorEvents = events.filter(e => e.type === "dispatch.error");
    expect(errorEvents.length).toBe(3);

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsFailed).toBe(3);
  });

  it("BUG-003: acceptance - dispatch.error event with actionable context", async () => {
    const task = await store.create({
      title: "Acceptance test",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Spawn failed: agent not available");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // ODD acceptance criteria: dispatch.error event with task ID and error details
    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.taskId).toBe(task.frontmatter.id);
    expect(errorEvent?.payload?.error).toContain("not available");
  });
});
