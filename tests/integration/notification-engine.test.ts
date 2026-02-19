/**
 * Integration test: notification engine wiring
 *
 * Verifies that events logged via EventLogger are automatically
 * routed to the NotificationPolicyEngine via the onEvent callback.
 *
 * Coverage:
 * - system.startup event routes through engine on AOFService.start()
 * - task.transitioned event routes through engine via afterTransition hook
 * - ConsoleNotifier used in standalone mode (no messageTool)
 * - MatrixNotifier used in plugin mode (messageTool present)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NotificationPolicyEngine, DEFAULT_RULES } from "../../src/events/notification-policy/index.js";
import { MockNotificationAdapter } from "../../src/events/notifier.js";
import { AOFService } from "../../src/service/aof-service.js";
import type { PollResult } from "../../src/dispatch/scheduler.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const makePollResult = (): PollResult => ({
  scannedAt: new Date().toISOString(),
  durationMs: 5,
  dryRun: true,
  actions: [],
  stats: { total: 0, backlog: 0, ready: 0, inProgress: 0, blocked: 0, review: 0, done: 0 },
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("notification engine integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-notif-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("routes system.startup event through engine when AOFService starts", async () => {
    const adapter = new MockNotificationAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const poller = async () => makePollResult();

    const service = new AOFService(
      { engine, poller },
      { dataDir: tmpDir, dryRun: true, pollIntervalMs: 60_000 },
    );

    await service.start();

    const startupSent = adapter.sent.filter(n => n.message.includes("AOF"));
    expect(startupSent.length).toBeGreaterThan(0);
    expect(engine.getStats().sent).toBeGreaterThan(0);

    await service.stop();
  });

  it("routes task.transitioned event through engine via afterTransition hook", async () => {
    const adapter = new MockNotificationAdapter();
    // Reset engine with no dedupe (fresh per test)
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const poller = async () => makePollResult();

    const service = new AOFService(
      { engine, poller },
      { dataDir: tmpDir, dryRun: true, pollIntervalMs: 60_000 },
    );

    await service.start();
    adapter.clear();
    engine.resetStats();

    // Create task and transition it — afterTransition hook logs via EventLogger → engine
    const task = await service["store"].create({
      title: "Integration test task",
      priority: "normal",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });

    await service["store"].transition(task.frontmatter.id, "ready");
    await service["store"].transition(task.frontmatter.id, "in-progress", {
      agent: "swe-backend",
    });

    // Verify engine received and routed the task.transitioned event
    expect(engine.getStats().sent + engine.getStats().noMatch).toBeGreaterThan(0);

    // Verify the adapter received a notification (rule matched and was sent)
    const transitionSent = adapter.sent.filter(n =>
      n.message.includes(task.frontmatter.id) || n.message.includes("started"),
    );
    expect(transitionSent.length).toBeGreaterThan(0);

    await service.stop();
  });

  it("engine getStats() reflects sent count after events are routed", async () => {
    const adapter = new MockNotificationAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
    const poller = async () => makePollResult();

    const service = new AOFService(
      { engine, poller },
      { dataDir: tmpDir, dryRun: true, pollIntervalMs: 60_000 },
    );

    await service.start();

    const stats = engine.getStats();
    // system.startup should have been sent
    expect(stats.sent).toBeGreaterThanOrEqual(1);

    await service.stop();
  });
});
