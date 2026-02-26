/**
 * BUG-004: No Task Dispatch Events - Event Log Incomplete
 * Date: 2026-02-08 18:30 EST
 * 
 * Tests verify complete dispatch lifecycle events are emitted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockAdapter } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-004: Dispatch Event Emission (P2)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug004-test-"));
    
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

  it("BUG-004: task.dispatch or action.started emitted when executor begins", async () => {
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

    // Should have dispatch start event
    const startEvent = events.find(
      e => (e.type === "task.dispatch" || e.type === "action.started") &&
           e.taskId === task.frontmatter.id
    );

    expect(startEvent).toBeDefined();
    expect(startEvent?.taskId).toBe(task.frontmatter.id);
  });

  it("BUG-004: action.completed emitted on successful dispatch", async () => {
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

    const completedEvent = events.find(
      e => e.type === "action.completed" && e.taskId === task.frontmatter.id
    );

    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload?.success).toBe(true);
  });

  it("BUG-004: action.completed emitted on dispatch failure", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Spawn failed");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const completedEvent = events.find(
      e => e.type === "action.completed" && e.taskId === task.frontmatter.id
    );

    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload?.success).toBe(false);
    expect(completedEvent?.payload?.error).toContain("failed");
  });

  it("BUG-004: events include task id in every entry", async () => {
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

    // All dispatch-related events should have taskId
    const dispatchEvents = events.filter(
      e => e.type === "action.started" || 
           e.type === "action.completed" || 
           e.type === "dispatch.matched" ||
           e.type === "task.dispatch"
    );

    expect(dispatchEvents.length).toBeGreaterThan(0);

    for (const event of dispatchEvents) {
      expect(event.taskId).toBeDefined();
      expect(event.taskId).toBe(task.frontmatter.id);
    }
  });

  it("BUG-004: events include agent id when available", async () => {
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

    const startEvent = events.find(
      e => e.type === "action.started" && e.taskId === task.frontmatter.id
    );

    expect(startEvent?.payload?.agent).toBe("test-agent");
  });

  it("BUG-004: events include timestamp", async () => {
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

    const dispatchEvents = events.filter(
      e => e.taskId === task.frontmatter.id
    );

    for (const event of dispatchEvents) {
      expect(event.timestamp).toBeDefined();
      expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
    }
  });

  it("BUG-004: complete dispatch lifecycle logged for successful task", async () => {
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

    const taskEvents = events.filter(e => e.taskId === task.frontmatter.id);

    // Should have at minimum: action.started, dispatch.matched, action.completed
    const hasStarted = taskEvents.some(e => e.type === "action.started");
    const hasMatched = taskEvents.some(e => e.type === "dispatch.matched");
    const hasCompleted = taskEvents.some(e => e.type === "action.completed");

    expect(hasStarted).toBe(true);
    expect(hasMatched).toBe(true);
    expect(hasCompleted).toBe(true);
  });

  it("BUG-004: multiple tasks produce independent event logs", async () => {
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Task ${i + 1}`,
        body: "Body",
        routing: { agent: `agent-${i + 1}` },
        createdBy: "test",
      });
      await store.transition(task.frontmatter.id, "ready");
      tasks.push(task);
    }

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Each task should have its own events
    for (const task of tasks) {
      const taskEvents = events.filter(e => e.taskId === task.frontmatter.id);
      expect(taskEvents.length).toBeGreaterThan(0);

      const hasStarted = taskEvents.some(e => e.type === "action.started");
      expect(hasStarted).toBe(true);
    }

    // All events should have unique combinations
    const startEvents = events.filter(e => e.type === "action.started");
    expect(startEvents.length).toBe(3);

    const taskIds = new Set(startEvents.map(e => e.taskId));
    expect(taskIds.size).toBe(3);
  });

  it("BUG-004: dispatch.matched includes session id on success", async () => {
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

    const matchedEvent = events.find(
      e => e.type === "dispatch.matched" && e.taskId === task.frontmatter.id
    );

    expect(matchedEvent).toBeDefined();
    expect(matchedEvent?.payload?.sessionId).toBeDefined();
  });

  it("BUG-004: dispatch.error includes error details on failure", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "failing-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Agent not found");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    const errorEvent = events.find(
      e => e.type === "dispatch.error" && e.taskId === task.frontmatter.id
    );

    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload?.error).toContain("not found");
    expect(errorEvent?.payload?.agent).toBe("failing-agent");
  });
});
