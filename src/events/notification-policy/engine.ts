/**
 * NotificationPolicyEngine — deterministic notification routing.
 *
 * Processing pipeline:
 *   BaseEvent → matchRule → resolveSeverity → dedupeCheck → renderTemplate → adapter.send()
 *
 * Design constraints:
 * - NO LLM calls — pure config lookup + rule evaluation
 * - Fail open — if adapter.send() throws, log and continue
 * - Works without OpenClaw (adapter is an interface, not a concrete class)
 */

import type { BaseEvent } from "../../schemas/event.js";
import type { NotificationAdapter } from "../notifier.js";
import {
  type NotificationRule,
  DEFAULT_RULES,
  matchesEventType,
} from "./rules.js";
import { DeduplicationStore } from "./deduper.js";
import { SeverityResolver } from "./severity.js";
import type { StormBatcher } from "./batcher.js";

export interface EngineOptions {
  /** Global dedupe window in ms. Default: 300_000 (5 minutes). */
  dedupeWindowMs?: number;
  /** Set false to disable all notifications (e.g. test environments). */
  enabled?: boolean;
  /** Optional storm batcher for high-volume event types. */
  batcher?: StormBatcher;
}

export interface EngineStats {
  sent: number;
  suppressed: number;
  noMatch: number;
  errors: number;
}

/**
 * Renders a template string by substituting {field.path} tokens with values
 * from the event object. Missing paths are left as the original token.
 *
 * Supports: {taskId}, {actor}, {payload.reason}, {payload.to}, etc.
 */
export function renderTemplate(template: string, event: BaseEvent): string {
  return template.replace(/\{([^}]+)\}/g, (original, path: string) => {
    const value = resolvePath(event as unknown as Record<string, unknown>, path);
    return value !== undefined && value !== null ? String(value) : original;
  });
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce((acc: unknown, key: string) => {
    if (acc !== null && acc !== undefined && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Returns true if all payload matchers in the rule match the event payload.
 */
function matchesPayload(
  rulePayload: Record<string, unknown> | undefined,
  event: BaseEvent
): boolean {
  if (!rulePayload) return true;
  const eventPayload = event.payload as Record<string, unknown> | undefined;
  for (const [key, expected] of Object.entries(rulePayload)) {
    if (eventPayload?.[key] !== expected) return false;
  }
  return true;
}

/**
 * Finds the first matching rule for the given event (first-match-wins).
 * Rules with payload conditions are naturally ordered before generic ones
 * in the DEFAULT_RULES array.
 */
function findMatchingRule(
  rules: NotificationRule[],
  event: BaseEvent
): NotificationRule | undefined {
  return rules.find(
    (rule) =>
      matchesEventType(rule.match.eventType, event.type) &&
      matchesPayload(rule.match.payload, event)
  );
}

export class NotificationPolicyEngine {
  private readonly adapter: NotificationAdapter;
  private readonly rules: NotificationRule[];
  private readonly deduper: DeduplicationStore;
  private readonly severity: SeverityResolver;
  private readonly enabled: boolean;
  private readonly batcher?: StormBatcher;
  private readonly stats: EngineStats = {
    sent: 0,
    suppressed: 0,
    noMatch: 0,
    errors: 0,
  };

  constructor(
    adapter: NotificationAdapter,
    rules: NotificationRule[] = DEFAULT_RULES,
    opts: EngineOptions = {}
  ) {
    this.adapter = adapter;
    this.rules = rules;
    this.deduper = new DeduplicationStore({ windowMs: opts.dedupeWindowMs });
    this.severity = new SeverityResolver();
    this.enabled = opts.enabled ?? true;
    this.batcher = opts.batcher;
  }

  /**
   * Main entry point. Call with any BaseEvent; engine handles routing,
   * deduplication, and delivery.
   *
   * Never throws — errors are logged and counted.
   */
  async handleEvent(event: BaseEvent): Promise<void> {
    if (!this.enabled) return;

    const rule = findMatchingRule(this.rules, event);

    if (!rule) {
      this.stats.noMatch++;
      return; // Silent drop — no matching rule
    }

    const effectiveSeverity = this.severity.resolve(rule.severity, event);
    const skipDedupe = this.severity.neverSuppress(event, rule.neverSuppress);

    if (!skipDedupe) {
      const allowed = this.deduper.shouldSend(
        event.taskId,
        event.type,
        rule.dedupeWindowMs
      );
      if (!allowed) {
        this.stats.suppressed++;
        return;
      }
    }

    const message = renderTemplate(rule.template, event);
    const channel = rule.channel;

    try {
      await this.adapter.send(channel, message);
      this.stats.sent++;
    } catch (err) {
      // Fail open — log and continue; never block event processing
      this.stats.errors++;
      console.error(
        `[NotificationPolicyEngine] Failed to send notification (${effectiveSeverity} → ${channel}):`,
        err
      );
    }
  }

  /** Returns a snapshot of engine statistics. */
  getStats(): Readonly<EngineStats> {
    return { ...this.stats };
  }

  /** Resets statistics counters (useful in tests). */
  resetStats(): void {
    this.stats.sent = 0;
    this.stats.suppressed = 0;
    this.stats.noMatch = 0;
    this.stats.errors = 0;
  }
}
