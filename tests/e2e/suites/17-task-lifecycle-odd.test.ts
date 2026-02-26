/**
 * E2E Suite 17: Full task lifecycle with ODD assertions (AOF-honeycomb-006)
 *
 * Covers the complete dispatch → exec → complete pipeline and verifies
 * every observable surface:
 *   - Event log JSONL entries (what an outside observer can read)
 *   - Prometheus metric gauges (what monitoring sees)
 *   - Filesystem task state (what the store persists)
 *
 * Uses src/testing/ helpers exclusively — no console spy assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import { EventLogger } from "../../../src/events/logger.js";
import { AOFMetrics } from "../../../src/metrics/exporter.js";
import { collectMetrics } from "../../../src/metrics/collector.js";
import { poll } from "../../../src/dispatch/scheduler.js";
import { MockAdapter } from "../../../src/dispatch/executor.js";
import {
  readEventLogEntries,
  findEvents,
  expectEvent,
  getMetricValue,
  readTasksInDir,
} from "../../../src/testing/index.js";

describe("E2E: Full task lifecycle with ODD assertions (AOF-honeycomb-006)", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;
  let metrics: AOFMetrics;
  let eventsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-e2e-lifecycle-"));
    eventsDir = join(tmpDir, "events");

    logger = new EventLogger(eventsDir);
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();

    executor = new MockAdapter();
    metrics = new AOFMetrics();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("dispatch produces observable event log entries and filesystem state", async () => {
    // Arrange
    const task = await store.create({
      title: "Lifecycle ODD Task",
      body: "# ODD Test\n\nVerify all observable surfaces.",
      routing: { agent: "swe-qa" },
      createdBy: "test-suite",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Act — one scheduler poll
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    // Assert — event log (ODD: what an outside observer can read)
    const events = await readEventLogEntries(eventsDir);
    expect(findEvents(events, "task.transitioned").length).toBeGreaterThanOrEqual(2);
    expectEvent(events, "scheduler.poll");
    expectEvent(events, "dispatch.matched");

    const dispatchEvt = expectEvent(events, "dispatch.matched");
    expect(dispatchEvt.taskId).toBe(task.frontmatter.id);

    // Assert — filesystem state (ODD: what's on disk)
    const inProgress = await readTasksInDir(join(tmpDir, "tasks", "in-progress"));
    expect(inProgress.find((t) => t.frontmatter.id === task.frontmatter.id)).toBeDefined();

    const ready = await readTasksInDir(join(tmpDir, "tasks", "ready"));
    expect(ready.find((t) => t.frontmatter.id === task.frontmatter.id)).toBeUndefined();

    // Assert — executor was called (spawn boundary)
    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0]!.context.taskId).toBe(task.frontmatter.id);
    expect(executor.spawned[0]!.context.agent).toBe("swe-qa");
  });

  it("metrics gauge reflects real task state after dispatch", async () => {
    const task = await store.create({
      title: "Metrics ODD Task",
      routing: { agent: "swe-backend" },
      createdBy: "test-suite",
    });
    await store.transition(task.frontmatter.id, "ready");

    const stateBefore = await collectMetrics(store);
    metrics.updateFromState(stateBefore);
    const readyBefore = (await getMetricValue(metrics, "aof_tasks_total", {
      state: "ready",
      agent: "all",
    })) ?? 0;
    expect(readyBefore).toBe(1);

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    const stateAfter = await collectMetrics(store);
    metrics.updateFromState(stateAfter);

    // After dispatch: ready drops to 0 (omitted from output when zero), in-progress rises to 1
    const readyAfter = await getMetricValue(metrics, "aof_tasks_total", {
      state: "ready",
      agent: "all",
    });
    expect(readyAfter ?? 0).toBe(0);

    const inProgressAfter = await getMetricValue(metrics, "aof_tasks_total", {
      state: "in-progress",
      agent: "all",
    });
    expect(inProgressAfter).toBe(1);
  });

  it("task completion emits done transition event and updates filesystem", async () => {
    const task = await store.create({
      title: "Completion ODD Task",
      routing: { agent: "swe-qa" },
      createdBy: "test-suite",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Dispatch to in-progress
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60_000,
      executor,
    });

    // Complete: in-progress → review → done
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    // Assert — event log shows full transition chain
    const events = await readEventLogEntries(eventsDir);
    const transitions = findEvents(events, "task.transitioned");
    const toStatuses = transitions.map((e) => e.payload?.toStatus ?? e.payload?.to);
    expect(toStatuses).toContain("in-progress");
    expect(toStatuses).toContain("review");
    expect(toStatuses).toContain("done");

    // Assert — task is in done/ on disk
    const doneTasks = await readTasksInDir(join(tmpDir, "tasks", "done"));
    expect(doneTasks.find((t) => t.frontmatter.id === task.frontmatter.id)).toBeDefined();

    // Assert — metrics reflect final state
    const state = await collectMetrics(store);
    metrics.updateFromState(state);
    const doneCount = await getMetricValue(metrics, "aof_tasks_total", {
      state: "done",
      agent: "all",
    });
    expect(doneCount).toBe(1);
  });
});
