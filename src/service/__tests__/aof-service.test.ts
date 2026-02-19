import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { MockNotificationAdapter } from "../../events/notifier.js";
import { NotificationPolicyEngine, DEFAULT_RULES } from "../../events/notification-policy/index.js";
import { AOFService } from "../aof-service.js";
import type { PollResult } from "../../dispatch/scheduler.js";

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
});
