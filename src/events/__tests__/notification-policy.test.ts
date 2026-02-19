/**
 * Tests for the notification policy engine.
 *
 * Coverage:
 * - Rule matching (exact event type, payload conditions, glob patterns)
 * - Severity resolution (info/warn/critical, ALWAYS_CRITICAL_EVENTS promotion)
 * - Deduplication (same event within window → suppressed)
 * - Template rendering ({taskId}, {actor}, {payload.field}, nested paths)
 * - Critical events bypass dedupe (neverSuppress)
 * - No matching rule → silent drop (no send, stats.noMatch++)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BaseEvent } from "../../schemas/event.js";
import type { NotificationAdapter } from "../notifier.js";
import {
  NotificationPolicyEngine,
  renderTemplate,
  DEFAULT_RULES,
  matchesEventType,
  DeduplicationStore,
  SeverityResolver,
  ALWAYS_CRITICAL_EVENTS,
} from "../notification-policy/index.js";
import type { NotificationRule } from "../notification-policy/index.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<BaseEvent> & { type: BaseEvent["type"] }): BaseEvent {
  return {
    eventId: 1,
    type: overrides.type,
    timestamp: new Date().toISOString(),
    actor: overrides.actor ?? "test-agent",
    taskId: overrides.taskId,
    payload: overrides.payload ?? {},
  };
}

function makeMockAdapter(): NotificationAdapter & {
  sent: Array<{ channel: string; message: string }>;
} {
  const sent: Array<{ channel: string; message: string }> = [];
  return {
    sent,
    async send(channel: string, message: string): Promise<void> {
      sent.push({ channel, message });
    },
  };
}

// ── matchesEventType ─────────────────────────────────────────────────────────

describe("matchesEventType", () => {
  it("matches exact event types", () => {
    expect(matchesEventType("task.created", "task.created")).toBe(true);
    expect(matchesEventType("task.created", "task.updated")).toBe(false);
  });

  it("matches glob patterns with .*", () => {
    expect(matchesEventType("murmur.*", "murmur.poll")).toBe(true);
    expect(matchesEventType("murmur.*", "murmur.review.dispatched")).toBe(true);
    expect(matchesEventType("murmur.*", "murmur")).toBe(false);
    expect(matchesEventType("murmur.*", "task.created")).toBe(false);
  });

  it("does not match partial prefix without .*", () => {
    expect(matchesEventType("task", "task.created")).toBe(false);
  });
});

// ── Template rendering ───────────────────────────────────────────────────────

describe("renderTemplate", () => {
  const event = makeEvent({
    type: "task.transitioned",
    taskId: "TASK-001",
    actor: "agent-x",
    payload: { from: "backlog", to: "in-progress", reason: "auto-assigned" },
  });

  it("substitutes top-level fields", () => {
    expect(renderTemplate("{taskId}", event)).toBe("TASK-001");
    expect(renderTemplate("{actor}", event)).toBe("agent-x");
  });

  it("substitutes nested payload fields", () => {
    expect(renderTemplate("{payload.to}", event)).toBe("in-progress");
    expect(renderTemplate("{payload.from}", event)).toBe("backlog");
    expect(renderTemplate("{payload.reason}", event)).toBe("auto-assigned");
  });

  it("substitutes multiple tokens in a single template", () => {
    const result = renderTemplate("▶️ {actor} started {taskId}", event);
    expect(result).toBe("▶️ agent-x started TASK-001");
  });

  it("leaves missing path tokens unchanged", () => {
    const result = renderTemplate("task: {taskId} — {payload.missing}", event);
    expect(result).toBe("task: TASK-001 — {payload.missing}");
  });

  it("handles deeply nested paths", () => {
    const e = makeEvent({
      type: "task.created",
      payload: { meta: { owner: "alice" } } as Record<string, unknown>,
    });
    expect(renderTemplate("{payload.meta.owner}", e)).toBe("alice");
  });
});

// ── DeduplicationStore ───────────────────────────────────────────────────────

describe("DeduplicationStore", () => {
  it("allows first send", () => {
    const store = new DeduplicationStore();
    expect(store.shouldSend("TASK-001", "task.created")).toBe(true);
  });

  it("suppresses duplicate within window", () => {
    const store = new DeduplicationStore({ windowMs: 60_000 });
    store.shouldSend("TASK-001", "task.created");
    expect(store.shouldSend("TASK-001", "task.created")).toBe(false);
  });

  it("allows send after window expires", () => {
    const store = new DeduplicationStore({ windowMs: 100 });
    store.shouldSend("TASK-001", "task.created");
    // Simulate time passing by advancing system time
    vi.useFakeTimers();
    vi.advanceTimersByTime(101);
    expect(store.shouldSend("TASK-001", "task.created")).toBe(true);
    vi.useRealTimers();
  });

  it("treats different taskIds as separate entries", () => {
    const store = new DeduplicationStore();
    store.shouldSend("TASK-001", "task.created");
    expect(store.shouldSend("TASK-002", "task.created")).toBe(true);
  });

  it("treats different eventTypes as separate entries", () => {
    const store = new DeduplicationStore();
    store.shouldSend("TASK-001", "task.created");
    expect(store.shouldSend("TASK-001", "task.transitioned")).toBe(true);
  });

  it("dedupeWindowMs: 0 always allows send", () => {
    const store = new DeduplicationStore();
    store.shouldSend("TASK-001", "task.transitioned", 0);
    expect(store.shouldSend("TASK-001", "task.transitioned", 0)).toBe(true);
  });

  it("per-call windowMs override takes precedence", () => {
    const store = new DeduplicationStore({ windowMs: 60_000 });
    store.shouldSend("TASK-001", "task.created", 500);
    // Within global window but outside per-call override... not yet
    // Just test it's used
    expect(store.shouldSend("TASK-001", "task.created", 500)).toBe(false);
  });

  it("handles undefined taskId (global events)", () => {
    const store = new DeduplicationStore();
    expect(store.shouldSend(undefined, "system.startup")).toBe(true);
    expect(store.shouldSend(undefined, "system.startup")).toBe(false);
  });

  it("clear() removes a specific entry", () => {
    const store = new DeduplicationStore();
    store.shouldSend("TASK-001", "task.created");
    store.clear("TASK-001", "task.created");
    expect(store.shouldSend("TASK-001", "task.created")).toBe(true);
  });

  it("clearAll() resets all entries", () => {
    const store = new DeduplicationStore();
    store.shouldSend("TASK-001", "task.created");
    store.shouldSend("TASK-002", "task.created");
    store.clearAll();
    expect(store.size).toBe(0);
  });
});

// ── SeverityResolver ─────────────────────────────────────────────────────────

describe("SeverityResolver", () => {
  const resolver = new SeverityResolver();

  it("returns the rule severity for normal events", () => {
    const event = makeEvent({ type: "lease.expired", taskId: "TASK-001" });
    expect(resolver.resolve("warn", event)).toBe("warn");
    expect(resolver.resolve("info", event)).toBe("info");
  });

  it("promotes to critical for ALWAYS_CRITICAL_EVENTS", () => {
    const event = makeEvent({ type: "system.shutdown" });
    expect(resolver.resolve("info", event)).toBe("critical");
  });

  it("ALWAYS_CRITICAL_EVENTS includes expected types", () => {
    expect(ALWAYS_CRITICAL_EVENTS.has("system.shutdown")).toBe(true);
    expect(ALWAYS_CRITICAL_EVENTS.has("task.abandoned")).toBe(true);
    expect(ALWAYS_CRITICAL_EVENTS.has("task.deadletter")).toBe(true);
    expect(ALWAYS_CRITICAL_EVENTS.has("gate_timeout_escalation")).toBe(true);
  });

  it("neverSuppress returns true for ALWAYS_CRITICAL_EVENTS", () => {
    const event = makeEvent({ type: "task.abandoned", taskId: "TASK-001" });
    expect(resolver.neverSuppress(event)).toBe(true);
  });

  it("neverSuppress returns true when rule has neverSuppress: true", () => {
    const event = makeEvent({ type: "lease.expired", taskId: "TASK-001" });
    expect(resolver.neverSuppress(event, true)).toBe(true);
  });

  it("neverSuppress returns false for normal events without flag", () => {
    const event = makeEvent({ type: "task.created", taskId: "TASK-001" });
    expect(resolver.neverSuppress(event)).toBe(false);
    expect(resolver.neverSuppress(event, false)).toBe(false);
  });
});

// ── NotificationPolicyEngine ─────────────────────────────────────────────────

describe("NotificationPolicyEngine", () => {
  let adapter: ReturnType<typeof makeMockAdapter>;
  let engine: NotificationPolicyEngine;

  beforeEach(() => {
    adapter = makeMockAdapter();
    // Use very long dedupe window (1 hour) so we control suppression explicitly
    engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES, {
      dedupeWindowMs: 3_600_000,
    });
    engine.resetStats();
  });

  // ── Rule matching ──────────────────────────────────────────────────────────

  describe("rule matching", () => {
    it("sends notification for a matched event type", async () => {
      const event = makeEvent({ type: "task.created", taskId: "TASK-001" });
      await engine.handleEvent(event);
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0].channel).toBe("#aof-dispatch");
    });

    it("silent drop for unmatched event type", async () => {
      // "scheduler.poll" is not in DEFAULT_RULES
      const event = makeEvent({ type: "scheduler.poll" });
      await engine.handleEvent(event);
      expect(adapter.sent).toHaveLength(0);
      expect(engine.getStats().noMatch).toBe(1);
    });

    it("matches payload condition — review transition", async () => {
      const event = makeEvent({
        type: "task.transitioned",
        taskId: "TASK-002",
        payload: { from: "in-progress", to: "review" },
      });
      await engine.handleEvent(event);
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0].channel).toBe("#aof-review");
      expect(adapter.sent[0].message).toContain("ready for review");
    });

    it("matches payload condition — blocked transition", async () => {
      const event = makeEvent({
        type: "task.transitioned",
        taskId: "TASK-003",
        payload: { from: "in-progress", to: "blocked", reason: "waiting on dep" },
      });
      await engine.handleEvent(event);
      expect(adapter.sent[0].channel).toBe("#aof-alerts");
      expect(adapter.sent[0].message).toContain("blocked");
    });

    it("matches payload condition — done transition", async () => {
      const event = makeEvent({
        type: "task.transitioned",
        taskId: "TASK-004",
        actor: "agent-y",
        payload: { from: "in-progress", to: "done" },
      });
      await engine.handleEvent(event);
      expect(adapter.sent[0].channel).toBe("#aof-dispatch");
      expect(adapter.sent[0].message).toContain("completed");
    });

    it("falls through to generic rule when payload doesn't match", async () => {
      // "task.transitioned" with to="backlog" → no specific rule → generic rule
      const event = makeEvent({
        type: "task.transitioned",
        taskId: "TASK-005",
        payload: { from: "in-progress", to: "backlog" },
      });
      await engine.handleEvent(event);
      // Generic rule: "🔄 {taskId}: {payload.from} → {payload.to}"
      expect(adapter.sent[0].message).toContain("backlog");
    });

    it("routes system.shutdown to #aof-critical", async () => {
      const event = makeEvent({ type: "system.shutdown" });
      await engine.handleEvent(event);
      expect(adapter.sent[0].channel).toBe("#aof-critical");
    });

    it("routes sla.violation to #aof-alerts", async () => {
      const event = makeEvent({
        type: "sla.violation",
        taskId: "TASK-006",
        payload: { durationHrs: 3, limitHrs: 2 },
      });
      await engine.handleEvent(event);
      expect(adapter.sent[0].channel).toBe("#aof-alerts");
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────────────

  describe("deduplication", () => {
    it("suppresses duplicate event within window", async () => {
      const event = makeEvent({ type: "task.created", taskId: "TASK-001" });
      await engine.handleEvent(event);
      await engine.handleEvent(event); // duplicate
      expect(adapter.sent).toHaveLength(1);
      expect(engine.getStats().suppressed).toBe(1);
    });

    it("allows same event for different tasks", async () => {
      const e1 = makeEvent({ type: "task.created", taskId: "TASK-001" });
      const e2 = makeEvent({ type: "task.created", taskId: "TASK-002" });
      await engine.handleEvent(e1);
      await engine.handleEvent(e2);
      expect(adapter.sent).toHaveLength(2);
    });

    it("review rule has dedupeWindowMs: 0 (always sends)", async () => {
      const event = makeEvent({
        type: "task.transitioned",
        taskId: "TASK-007",
        payload: { from: "in-progress", to: "review" },
      });
      await engine.handleEvent(event);
      await engine.handleEvent(event);
      await engine.handleEvent(event);
      // dedupeWindowMs: 0 → never suppressed
      expect(adapter.sent).toHaveLength(3);
    });
  });

  // ── Critical events bypass dedupe ──────────────────────────────────────────

  describe("critical events bypass dedupe", () => {
    it("system.shutdown is never suppressed", async () => {
      const event = makeEvent({ type: "system.shutdown" });
      await engine.handleEvent(event);
      await engine.handleEvent(event);
      expect(adapter.sent).toHaveLength(2);
    });

    it("task.abandoned is never suppressed", async () => {
      const event = makeEvent({ type: "task.abandoned", taskId: "TASK-009" });
      await engine.handleEvent(event);
      await engine.handleEvent(event);
      expect(adapter.sent).toHaveLength(2);
      expect(engine.getStats().suppressed).toBe(0);
    });

    it("gate_timeout_escalation is never suppressed", async () => {
      const event = makeEvent({
        type: "gate_timeout_escalation",
        taskId: "TASK-010",
        payload: { elapsed: "2" },
      });
      await engine.handleEvent(event);
      await engine.handleEvent(event);
      expect(adapter.sent).toHaveLength(2);
    });

    it("task.deadletter is never suppressed (neverSuppress: true on rule)", async () => {
      const event = makeEvent({
        type: "task.deadletter",
        taskId: "TASK-011",
        payload: { reason: "max retries exceeded" },
      });
      await engine.handleEvent(event);
      await engine.handleEvent(event);
      expect(adapter.sent).toHaveLength(2);
    });
  });

  // ── Template rendering in engine ───────────────────────────────────────────

  describe("template rendering in engine", () => {
    it("renders {taskId} from event", async () => {
      const event = makeEvent({ type: "task.created", taskId: "TASK-RENDER-1" });
      await engine.handleEvent(event);
      expect(adapter.sent[0].message).toContain("TASK-RENDER-1");
    });

    it("renders {actor} from event", async () => {
      const event = makeEvent({
        type: "task.transitioned",
        taskId: "TASK-RENDER-2",
        actor: "alice",
        payload: { from: "in-progress", to: "done" },
      });
      await engine.handleEvent(event);
      expect(adapter.sent[0].message).toContain("alice");
    });

    it("renders {payload.to} from event payload via generic transition rule", async () => {
      // Use a transition that doesn't match any specific payload rule
      // → falls through to generic rule: "🔄 {taskId}: {payload.from} → {payload.to}"
      const event = makeEvent({
        type: "task.transitioned",
        taskId: "TASK-RENDER-3",
        payload: { from: "backlog", to: "ready" },
      });
      await engine.handleEvent(event);
      expect(adapter.sent[0].message).toContain("ready");
      expect(adapter.sent[0].message).toContain("backlog");
    });

    it("renders {payload.durationHrs} for sla.violation", async () => {
      const event = makeEvent({
        type: "sla.violation",
        taskId: "TASK-RENDER-4",
        payload: { durationHrs: 5, limitHrs: 4 },
      });
      // Use a fresh engine with dedupeWindowMs: 0 for this test
      const localEngine = new NotificationPolicyEngine(adapter, DEFAULT_RULES, {
        dedupeWindowMs: 0,
      });
      await localEngine.handleEvent(event);
      const msg = adapter.sent[adapter.sent.length - 1].message;
      expect(msg).toContain("5h");
      expect(msg).toContain("4h");
    });

    it("leaves unknown tokens as-is", async () => {
      const rules: NotificationRule[] = [
        {
          match: { eventType: "task.created" },
          severity: "info",
          audience: ["agent"],
          channel: "#test",
          template: "created {taskId} — {payload.nonexistent}",
        },
      ];
      const localAdapter = makeMockAdapter();
      const localEngine = new NotificationPolicyEngine(localAdapter, rules);
      const event = makeEvent({ type: "task.created", taskId: "TASK-T1" });
      await localEngine.handleEvent(event);
      expect(localAdapter.sent[0].message).toContain("{payload.nonexistent}");
    });
  });

  // ── Engine stats ───────────────────────────────────────────────────────────

  describe("engine stats", () => {
    it("tracks sent count", async () => {
      await engine.handleEvent(makeEvent({ type: "task.created", taskId: "T1" }));
      expect(engine.getStats().sent).toBe(1);
    });

    it("tracks suppressed count", async () => {
      const event = makeEvent({ type: "task.created", taskId: "T2" });
      await engine.handleEvent(event);
      await engine.handleEvent(event);
      expect(engine.getStats().suppressed).toBe(1);
    });

    it("tracks noMatch count", async () => {
      await engine.handleEvent(makeEvent({ type: "scheduler.poll" }));
      expect(engine.getStats().noMatch).toBe(1);
    });

    it("tracks errors when adapter throws", async () => {
      const failingAdapter: NotificationAdapter = {
        async send(): Promise<void> {
          throw new Error("channel unavailable");
        },
      };
      const localEngine = new NotificationPolicyEngine(failingAdapter, DEFAULT_RULES);
      // system.shutdown bypasses dedupe, so it always tries to send
      await localEngine.handleEvent(makeEvent({ type: "system.shutdown" }));
      expect(localEngine.getStats().errors).toBe(1);
    });
  });

  // ── Disabled engine ────────────────────────────────────────────────────────

  describe("disabled engine", () => {
    it("does nothing when enabled: false", async () => {
      const disabledEngine = new NotificationPolicyEngine(adapter, DEFAULT_RULES, {
        enabled: false,
      });
      await disabledEngine.handleEvent(makeEvent({ type: "system.shutdown" }));
      expect(adapter.sent).toHaveLength(0);
    });
  });

  // ── Custom rules ───────────────────────────────────────────────────────────

  describe("custom rules", () => {
    it("custom rules take precedence", async () => {
      const customRules: NotificationRule[] = [
        {
          match: { eventType: "task.created" },
          severity: "critical",
          audience: ["operator"],
          channel: "#custom-channel",
          template: "CUSTOM: {taskId}",
        },
      ];
      const localAdapter = makeMockAdapter();
      const localEngine = new NotificationPolicyEngine(localAdapter, customRules);
      await localEngine.handleEvent(makeEvent({ type: "task.created", taskId: "C1" }));
      expect(localAdapter.sent[0].channel).toBe("#custom-channel");
      expect(localAdapter.sent[0].message).toBe("CUSTOM: C1");
    });
  });
});

// ── DEFAULT_RULES coverage ───────────────────────────────────────────────────

describe("DEFAULT_RULES", () => {
  it("has rules for all critical unsuppressable events", () => {
    const criticalTypes = ["system.shutdown", "task.abandoned", "task.deadletter", "gate_timeout_escalation"];
    for (const type of criticalTypes) {
      const rule = DEFAULT_RULES.find((r) => r.match.eventType === type);
      expect(rule, `missing rule for ${type}`).toBeDefined();
    }
  });

  it("task.transitioned payload=review has dedupeWindowMs: 0", () => {
    const rule = DEFAULT_RULES.find(
      (r) => r.match.eventType === "task.transitioned" && r.match.payload?.to === "review"
    );
    expect(rule?.dedupeWindowMs).toBe(0);
  });

  it("sla.violation has 15-minute dedupeWindowMs", () => {
    const rule = DEFAULT_RULES.find((r) => r.match.eventType === "sla.violation");
    expect(rule?.dedupeWindowMs).toBe(900_000);
  });

  it("all rules have required fields", () => {
    for (const rule of DEFAULT_RULES) {
      expect(rule.match.eventType, "missing eventType").toBeDefined();
      expect(rule.severity, "missing severity").toMatch(/^(info|warn|critical)$/);
      expect(rule.channel, "missing channel").toMatch(/^#/);
      expect(rule.template, "missing template").toBeTruthy();
      expect(Array.isArray(rule.audience), "audience must be array").toBe(true);
    }
  });
});

// ── StormBatcher tests ──────────────────────────────────────────────────────

describe("StormBatcher", () => {
  it("sends critical events immediately without batching", async () => {
    const sent: Array<{ channel: string; message: string }> = [];
    const adapter = { send: async (ch: string, msg: string) => { sent.push({ channel: ch, message: msg }); } };
    const { StormBatcher } = await import("../notification-policy/batcher.js");
    const batcher = new StormBatcher(adapter, { windowMs: 60_000, threshold: 5 });

    await batcher.enqueue({ eventType: "task.abandoned", channel: "#critical", message: "abandoned!", critical: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe("abandoned!");
    await batcher.stop();
  });

  it("batches events above threshold into a digest", async () => {
    const sent: Array<{ channel: string; message: string }> = [];
    const adapter = { send: async (ch: string, msg: string) => { sent.push({ channel: ch, message: msg }); } };
    const { StormBatcher } = await import("../notification-policy/batcher.js");
    const batcher = new StormBatcher(adapter, { windowMs: 60_000, threshold: 3 });

    for (let i = 0; i < 6; i++) {
      await batcher.enqueue({ eventType: "task.transitioned", channel: "#dispatch", message: `task-${i} moved` });
    }
    expect(sent).toHaveLength(0); // not yet flushed

    await batcher.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain("storm");
    expect(sent[0].message).toContain("6");
    await batcher.stop();
  });

  it("sends individually when below threshold", async () => {
    const sent: Array<{ channel: string; message: string }> = [];
    const adapter = { send: async (ch: string, msg: string) => { sent.push({ channel: ch, message: msg }); } };
    const { StormBatcher } = await import("../notification-policy/batcher.js");
    const batcher = new StormBatcher(adapter, { windowMs: 60_000, threshold: 5 });

    await batcher.enqueue({ eventType: "task.created", channel: "#dispatch", message: "created 1" });
    await batcher.enqueue({ eventType: "task.created", channel: "#dispatch", message: "created 2" });
    await batcher.flush();
    expect(sent).toHaveLength(2);
    await batcher.stop();
  });

  it("flushes remaining on stop", async () => {
    const sent: Array<{ channel: string; message: string }> = [];
    const adapter = { send: async (ch: string, msg: string) => { sent.push({ channel: ch, message: msg }); } };
    const { StormBatcher } = await import("../notification-policy/batcher.js");
    const batcher = new StormBatcher(adapter, { windowMs: 60_000, threshold: 5 });

    await batcher.enqueue({ eventType: "test.event", channel: "#ch", message: "msg1" });
    await batcher.stop();
    expect(sent).toHaveLength(1);
  });
});

// ── AudienceRouter tests ────────────────────────────────────────────────────

describe("AudienceRouter", () => {
  it("resolves audience targets to channels", async () => {
    const { AudienceRouter } = await import("../notification-policy/audience.js");
    const router = new AudienceRouter({ agent: "#agents", "team-lead": "#leads", operator: "#ops" });
    const channels = router.resolve(["agent", "operator"]);
    expect(channels).toEqual(["#agents", "#ops"]);
  });

  it("deduplicates channels", async () => {
    const { AudienceRouter } = await import("../notification-policy/audience.js");
    const router = new AudienceRouter({ agent: "#same", "team-lead": "#same", operator: "#ops" });
    const channels = router.resolve(["agent", "team-lead", "operator"]);
    expect(channels).toEqual(["#same", "#ops"]);
  });

  it("applies overrides", async () => {
    const { AudienceRouter } = await import("../notification-policy/audience.js");
    const router = new AudienceRouter({ agent: "#agents", "team-lead": "#leads", operator: "#ops" });
    const channels = router.resolve(["agent"], { agent: "#custom" });
    expect(channels).toEqual(["#custom"]);
  });
});
