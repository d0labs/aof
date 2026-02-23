import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { MockNotificationAdapter } from "../../events/notifier.js";
import { NotificationPolicyEngine, DEFAULT_RULES } from "../../events/notification-policy/index.js";
import { AOFService } from "../aof-service.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import { getMetricValue } from "../../testing/metrics-reader.js";
import type { PollResult } from "../../dispatch/scheduler.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("AOFService", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  const makePollResult = (): PollResult => ({
    scannedAt: new Date().toISOString(),
    durationMs: 5,
    dryRun: true,
    actions: [],
    stats: {
      total: 0,
      backlog: 0,
      ready: 0,
      inProgress: 0,
      blocked: 0,
      review: 0,
      done: 0,
    },
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-service-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts and runs an initial poll", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    expect(poller).toHaveBeenCalledTimes(1);
    const status = service.getStatus();
    expect(status.running).toBe(true);
    expect(status.lastPollAt).toBeDefined();

    await service.stop();
  });

  it("triggers a poll on message events", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();
    await service.handleMessageReceived({ from: "swe-backend" });

    expect(poller).toHaveBeenCalledTimes(2);

    await service.stop();
  });

  it("does not poll after stop", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();
    await service.stop();
    await service.handleSessionEnd();

    expect(poller).toHaveBeenCalledTimes(1);
  });

  it("routes protocol messages before polling", async () => {
    const poller = vi.fn(async () => makePollResult());
    const protocolRouter = { route: vi.fn() };
    const service = new AOFService(
      { store, logger, poller, protocolRouter },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    await service.handleMessageReceived({
      payload: {
        protocol: "aof",
        version: 1,
        projectId: "test-project",
        type: "status.update",
        taskId: "TASK-2026-02-09-058",
        fromAgent: "swe-backend",
        toAgent: "swe-qa",
        sentAt: "2026-02-09T21:00:00.000Z",
        payload: {
          taskId: "TASK-2026-02-09-058",
          agentId: "swe-backend",
          status: "blocked",
          progress: "Waiting on API key",
          blockers: ["API key pending"],
          notes: "ETA tomorrow",
        },
      },
    });

    expect(protocolRouter.route).toHaveBeenCalledTimes(1);
    expect(poller).toHaveBeenCalledTimes(2);

    await service.stop();
  });

  it("sends startup notification via engine when engine is provided", async () => {
    const adapter = new MockNotificationAdapter();
    // Don't pass logger — let service create its own (wired to engine)
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const poller = vi.fn(async () => makePollResult());

    const service = new AOFService(
      { store, poller, engine },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // Engine should have routed the system.startup event
    expect(adapter.sent.length).toBeGreaterThan(0);
    const startupNotifications = adapter.sent.filter(n =>
      n.message.includes("started") || n.message.includes("AOF"),
    );
    expect(startupNotifications.length).toBeGreaterThan(0);

    await service.stop();
  });

  it("routes task transitions through engine via EventLogger", async () => {
    const adapter = new MockNotificationAdapter();
    // Don't pass logger — let service create its own (wired to engine)
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const poller = vi.fn(async () => makePollResult());

    // Don't pass store — let service create it with hooks
    const service = new AOFService(
      { poller, engine },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // Create a task and transition it via service's store
    const task = await service["store"].create({
      title: "Test notification task",
      priority: "normal",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });

    adapter.clear();

    await service["store"].transition(task.frontmatter.id, "ready", {
      agent: "swe-backend",
      reason: "Starting work",
    });

    // Engine should have routed task.transitioned through the adapter
    expect(adapter.sent.length).toBeGreaterThan(0);
    const transitionNotifications = adapter.sent.filter(n =>
      n.message.includes(task.frontmatter.id) ||
      n.message.includes("ready") ||
      n.message.includes("backlog"),
    );
    expect(transitionNotifications.length).toBeGreaterThan(0);

    await service.stop();
  });

  it("ODD: emits system.startup event to EventLogger on start", async () => {
    const capturedEvents: BaseEvent[] = [];
    const eventLogger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => capturedEvents.push(event),
    });
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger: eventLogger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: event log contains system.startup
    const startupEvent = capturedEvents.find(e => e.type === "system.startup");
    expect(startupEvent).toBeDefined();

    await service.stop();
  });

  it("ODD: events.jsonl written to filesystem after start", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: filesystem state — events.jsonl exists and contains startup event
    const eventsPath = join(tmpDir, "events", "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n").map(l => JSON.parse(l));
    expect(events.some((e: { type: string }) => e.type === "system.startup")).toBe(true);

    await service.stop();
  });

  it("ODD: aof_scheduler_poll_failures_total increments on poll error", async () => {
    const metrics = new AOFMetrics();
    const failingPoller = vi.fn(async (): Promise<PollResult> => {
      throw new Error("Simulated poll failure");
    });
    const service = new AOFService(
      { store, logger, poller: failingPoller, metrics },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: metric counter incremented after poll error
    const failures = await getMetricValue(metrics, "aof_scheduler_poll_failures_total");
    expect(failures).toBeGreaterThanOrEqual(1);

    await service.stop();
  });

  it("ODD: getStatus reflects poll results after start", async () => {
    const poller = vi.fn(async () => makePollResult());
    const service = new AOFService(
      { store, logger, poller },
      { dataDir: tmpDir, pollIntervalMs: 60_000, dryRun: true },
    );

    await service.start();

    // ODD: observable state via getStatus — lastPollAt updated after poll
    const status = service.getStatus();
    expect(status.running).toBe(true);
    expect(status.lastPollAt).toBeDefined();
    expect(new Date(status.lastPollAt!).getTime()).toBeLessThanOrEqual(Date.now());

    await service.stop();

    // ODD: after stop, running is false
    expect(service.getStatus().running).toBe(false);
  });
});
