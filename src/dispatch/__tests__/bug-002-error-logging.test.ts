/**
 * BUG-002: Missing Logging for Executor Failures
 * Date: 2026-02-08 19:00 EST
 *
 * Tests verify error events are emitted when executor is missing or fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockAdapter } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-002: Error Logging for Executor Failures (P1)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug002-err-test-"));

    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });

    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();

    executor = new MockAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-002: scheduler.poll has reason when executor is undefined", async () => {
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
      executor: undefined, // No executor configured
    });

    // ODD: scheduler.poll event records the no_executor reason
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.reason).toBeDefined();
  });

  it("BUG-002: dispatch.error event on executor spawn failure", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "failing-agent" },
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

    // ODD: dispatch.error event logged with error details
    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload?.error).toContain("not found");
  });

  it("BUG-002: ERROR event includes actionable reason", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "bad-agent" },
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

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent?.payload?.error).toContain("timeout");
    expect(errorEvent?.taskId).toBe(task.frontmatter.id);
  });

  it("BUG-002: poll event includes actionsFailed count", async () => {
    for (let i = 0; i < 2; i++) {
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

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsFailed).toBe(2);
    expect(pollEvent?.payload?.actionsExecuted).toBe(0);
  });

  it("BUG-002: dispatch.error event on executor exception", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.spawnSession = vi.fn().mockRejectedValue(new Error("Spawn exception with stack"));

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // ODD: dispatch.error event with exception message
    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent?.payload?.error).toContain("exception");
  });

  it("BUG-002: acceptance - dispatch.error event for all failure modes", async () => {
    // Scenario 1: Executor undefined → poll reason recorded
    const task1 = await store.create({
      title: "Task 1",
      body: "Body",
      routing: { agent: "agent-1" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: undefined,
    });

    const pollEvent1 = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent1?.payload?.reason).toBeDefined();

    events.length = 0; // Reset event log

    // Scenario 2: Executor spawn fails → dispatch.error event
    const task2 = await store.create({
      title: "Task 2",
      body: "Body",
      routing: { agent: "agent-2" },
      createdBy: "test",
    });
    await store.transition(task2.frontmatter.id, "ready");

    executor.setShouldFail(true);

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
  });
});
