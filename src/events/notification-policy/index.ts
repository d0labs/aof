/**
 * Notification policy engine — public surface.
 *
 * Usage:
 *   import { NotificationPolicyEngine, DEFAULT_RULES } from "./notification-policy/index.js";
 *
 *   const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);
 *   await engine.handleEvent(event);
 */

export { NotificationPolicyEngine, renderTemplate } from "./engine.js";
export type { EngineOptions, EngineStats } from "./engine.js";

export { DEFAULT_RULES, matchesEventType } from "./rules.js";
export type { NotificationRule, Severity, Audience } from "./rules.js";

export { DeduplicationStore } from "./deduper.js";
export type { DedupeOptions } from "./deduper.js";

export { SeverityResolver, ALWAYS_CRITICAL_EVENTS } from "./severity.js";

export { StormBatcher } from "./batcher.js";
export type { StormBatcherOptions, QueuedNotification } from "./batcher.js";

export { AudienceRouter } from "./audience.js";
export type { AudienceChannelMap } from "./audience.js";
