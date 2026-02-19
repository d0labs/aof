/**
 * Event log schema — JSONL event stream for audit, metrics, and future UI.
 *
 * Every state transition, dispatch decision, lease operation, and org
 * mutation is recorded as an event. This feeds:
 * - Prometheus metrics (counters, histograms)
 * - Future animated org chart UI
 * - Audit trail
 */

import { z } from "zod";
import { TaskId } from "./task.js";
// Task status type will be used when we add typed event constructors
// import type { TaskStatus } from "./task.js";

/** Event types — exhaustive list of observable actions. */
export const EventType = z.enum([
  // Task lifecycle
  "task.created",
  "task.updated",
  "task.transitioned",
  "task.assigned",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.blocked",
  "task.unblocked",
  "task.validation.failed",
  "task.deadletter",
  "task.resurrected",
  "task.dep.added",
  "task.dep.removed",

  // Project management
  "project.validation.failed",

  // Lease management
  "lease.acquired",
  "lease.renewed",
  "lease.expired",
  "lease.released",

  // Dispatch
  "dispatch.matched",
  "dispatch.no-match",
  "dispatch.fallback",
  "dispatch.error",

  // Dependencies
  "dependency.cascaded",  // A dependency status change cascaded to dependents
  
  // Gate workflow
  "gate_transition",
  "gate_timeout",
  "gate_timeout_escalation",

  // Delegation
  "delegation.requested",
  "delegation.accepted",
  "delegation.rejected",

  // Org chart
  "org.agent-added",
  "org.agent-removed",
  "org.agent-updated",
  "org.team-changed",
  "org.routing-updated",

  // Knowledge sharing
  "knowledge.shared",
  "knowledge.received",

  // Context
  "context.budget",
  "context.footprint",
  "context.alert",

  // System
  "system.startup",
  "system.shutdown",
  "system.config-changed",
  "system.drift-detected",
  "system.recovery",

  // Recovery
  "recovery_action",

  // SLA
  "sla.violation",

  // Scheduler
  "scheduler.poll",

  // Concurrency
  "concurrency.platformLimit",

  // Protocol
  "protocol.message.received",
  "protocol.message.rejected",
  "protocol.message.unknown",
  "protocol.message.warning",

  // Actions
  "action.started",
  "action.completed",

  // Murmur
  "murmur.poll",
  "murmur.evaluation.error",
  "murmur.evaluation.failed",
  "murmur.review.created",
  "murmur.review.dispatched",
  "murmur.review.dispatch_failed",
  "murmur.review.dispatch_error",
  "murmur.trigger.skipped",
  "murmur.cleanup.stale",
  "murmur_task_created",
  "murmur_create_task",

  // Scheduler alerts
  "scheduler_alert",
  "scheduler_action_failed",
]);
export type EventType = z.infer<typeof EventType>;

/** Base event structure. */
export const BaseEvent = z.object({
  /** Monotonic event ID (set by event logger). */
  eventId: z.number().int().positive(),
  /** Event type. */
  type: EventType,
  /** ISO-8601 timestamp. */
  timestamp: z.string().datetime(),
  /** Agent or system that caused this event. */
  actor: z.string(),
  /** Optional task ID (for task-related events). */
  taskId: TaskId.optional(),
  /** Event-specific payload. */
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type BaseEvent = z.infer<typeof BaseEvent>;

/** Transition event payload. */
export const TransitionPayload = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.string().optional(),
});

/** Delegation event payload. */
export const DelegationPayload = z.object({
  fromAgent: z.string(),
  toAgent: z.string(),
  taskId: TaskId,
  reason: z.string().optional(),
});

/** Dispatch event payload. */
export const DispatchPayload = z.object({
  taskId: TaskId,
  targetAgent: z.string().optional(),
  method: z.enum(["spawn", "send", "cli"]).optional(),
  fallbackUsed: z.boolean().default(false),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});
