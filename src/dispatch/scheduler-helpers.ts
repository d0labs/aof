/**
 * Helper functions for scheduler poll cycle.
 * 
 * Extracted to keep scheduler.ts focused on orchestration.
 */

import type { Task } from "../schemas/task.js";
import type { SchedulerAction } from "./scheduler.js";

/**
 * Build task statistics by status.
 */
export function buildTaskStats(allTasks: Task[]) {
  const stats = {
    total: allTasks.length,
    backlog: 0,
    ready: 0,
    inProgress: 0,
    blocked: 0,
    review: 0,
    done: 0,
  };

  for (const task of allTasks) {
    const s = task.frontmatter.status;
    if (s === "backlog") stats.backlog++;
    else if (s === "ready") stats.ready++;
    else if (s === "in-progress") stats.inProgress++;
    else if (s === "blocked") stats.blocked++;
    else if (s === "review") stats.review++;
    else if (s === "done") stats.done++;
  }

  return stats;
}

/**
 * Build parent→children task map.
 */
export function buildChildrenMap(allTasks: Task[]): Map<string, Task[]> {
  const childrenByParent = new Map<string, Task[]>();
  for (const task of allTasks) {
    const parentId = task.frontmatter.parentId;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(task);
    childrenByParent.set(parentId, list);
  }
  return childrenByParent;
}

/**
 * Check for expired leases and return expiry actions.
 * BUG-AUDIT-001: checks both in-progress AND blocked tasks.
 */
export function checkExpiredLeases(allTasks: Task[]): SchedulerAction[] {
  const actions: SchedulerAction[] = [];
  const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");
  const blockedTasks = allTasks.filter(t => t.frontmatter.status === "blocked");
  const tasksWithPotentialLeases = [...inProgressTasks, ...blockedTasks];

  for (const task of tasksWithPotentialLeases) {
    const lease = task.frontmatter.lease;
    if (!lease) continue;

    const expiresAt = new Date(lease.expiresAt).getTime();
    if (expiresAt <= Date.now()) {
      const expiredDuration = Date.now() - expiresAt;
      actions.push({
        type: "expire_lease",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        agent: lease.agent,
        reason: `Lease expired at ${lease.expiresAt} (held by ${lease.agent}, expired ${Math.round(expiredDuration / 1000)}s ago)`,
        fromStatus: task.frontmatter.status,
      });
    }
  }

  return actions;
}

/**
 * Build resource occupancy map.
 * TASK-054: Track which resources are currently occupied by in-progress tasks.
 */
export function buildResourceOccupancyMap(allTasks: Task[]): Map<string, string> {
  const occupiedResources = new Map<string, string>(); // resource -> taskId
  const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");
  
  for (const task of inProgressTasks) {
    const resource = task.frontmatter.resource;
    if (resource) {
      occupiedResources.set(resource, task.frontmatter.id);
    }
  }
  
  return occupiedResources;
}

/**
 * Check backlog tasks for promotion eligibility.
 */
export function checkBacklogPromotion(
  allTasks: Task[],
  childrenByParent: Map<string, Task[]>,
  checkPromotionEligibility: (task: Task, allTasks: Task[], childrenByParent: Map<string, Task[]>) => { eligible: boolean; reason?: string }
): SchedulerAction[] {
  const actions: SchedulerAction[] = [];
  const backlogTasks = allTasks.filter(t => t.frontmatter.status === "backlog");
  
  for (const task of backlogTasks) {
    const canPromote = checkPromotionEligibility(task, allTasks, childrenByParent);
    
    if (canPromote.eligible) {
      actions.push({
        type: "promote",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "Auto-promotion: all requirements met",
        fromStatus: "backlog",
        toStatus: "ready",
      });
    }
  }
  
  return actions;
}

/** Default maximum dispatch retries before deadletter. */
export const DEFAULT_MAX_DISPATCH_RETRIES = 3;

/** Patterns that indicate permanent (non-retryable) spawn errors. */
const PERMANENT_ERROR_PATTERNS = [
  "agent not found",
  "agent_not_found",
  "no such agent",
  "agent deregistered",
  "permission denied",
  "forbidden",
  "unauthorized",
];

/** Patterns that indicate rate-limit errors (retryable, but distinct for observability). */
const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "429",
  "throttled",
  "quota exceeded",
];

/**
 * Classify a spawn error as transient, permanent, or rate_limited.
 * Permanent errors should deadletter immediately (no retry).
 * Rate-limited errors are retried with backoff (same as transient) but
 * tracked separately for observability and future circuit-breaker (Phase 4, HEAL-03).
 */
export function classifySpawnError(error: string): "transient" | "permanent" | "rate_limited" {
  const lower = error.toLowerCase();
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (lower.includes(pattern)) return "permanent";
  }
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (lower.includes(pattern)) return "rate_limited";
  }
  return "transient";
}

/**
 * Compute exponential backoff delay for spawn failure retries with jitter.
 * Formula: min(baseMs * 3^retryCount, ceilingMs) +/- jitter
 * Base gives: 60s, 180s, 540s, 900s, 900s, ...
 * Jitter prevents thundering herd when multiple tasks retry simultaneously.
 *
 * @param retryCount - Current retry attempt (0-based)
 * @param opts.baseMs - Base delay in ms (default: 60,000 = 1 minute)
 * @param opts.ceilingMs - Maximum delay in ms (default: 900,000 = 15 minutes)
 * @param opts.jitterFactor - Jitter range as fraction of delay (default: 0.25 = +/-25%)
 * @param opts.jitterFn - Random number generator [0,1) for test determinism (default: Math.random)
 */
export function computeRetryBackoffMs(retryCount: number, opts?: {
  baseMs?: number;
  ceilingMs?: number;
  jitterFactor?: number;
  jitterFn?: () => number;
}): number {
  const baseMs = opts?.baseMs ?? 60_000;
  const ceilingMs = opts?.ceilingMs ?? 15 * 60_000;
  const jitterFactor = opts?.jitterFactor ?? 0.25;
  const random = opts?.jitterFn ?? Math.random;

  const delay = Math.min(baseMs * Math.pow(3, retryCount), ceilingMs);
  const jitter = delay * jitterFactor * (random() * 2 - 1); // +/- jitterFactor
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Shared guard: should a spawn-failed task be requeued for retry?
 * Used by both checkBlockedTaskRecovery and the lease-expiry handler.
 */
export function shouldAllowSpawnFailedRequeue(
  task: Task,
  maxRetries: number
): { allow: boolean; reason?: string; shouldDeadletter?: boolean } {
  const retryCount = (task.frontmatter.metadata?.retryCount as number) ?? 0;
  const lastBlockedAt = task.frontmatter.metadata?.lastBlockedAt as string | undefined;
  const errorClass = task.frontmatter.metadata?.errorClass as string | undefined;

  // Permanent errors should never be retried
  // Note: rate_limited falls through to retry logic (same as transient).
  // Phase 4 (HEAL-03) adds circuit breaker for rate_limited errors.
  if (errorClass === "permanent") {
    return {
      allow: false,
      reason: `Permanent error — deadletter immediately`,
      shouldDeadletter: true,
    };
  }

  // Max retries exceeded → deadletter
  if (retryCount >= maxRetries) {
    return {
      allow: false,
      reason: `Max retries (${maxRetries}) exceeded`,
      shouldDeadletter: true,
    };
  }

  // Check backoff timing
  if (lastBlockedAt) {
    const blockedAge = Date.now() - new Date(lastBlockedAt).getTime();
    const requiredBackoff = computeRetryBackoffMs(retryCount);
    if (blockedAge < requiredBackoff) {
      return {
        allow: false,
        reason: `Backoff not elapsed (${Math.round(blockedAge / 1000)}s / ${Math.round(requiredBackoff / 1000)}s)`,
        shouldDeadletter: false,
      };
    }
  }

  return {
    allow: true,
    reason: `Retry attempt ${retryCount + 1}/${maxRetries}`,
  };
}

/**
 * Check blocked tasks for unblocking/recovery.
 * Handles both dependency-based blocks and dispatch-failure retries.
 */
export function checkBlockedTaskRecovery(
  allTasks: Task[],
  childrenByParent: Map<string, Task[]>,
  maxRetries: number = DEFAULT_MAX_DISPATCH_RETRIES
): SchedulerAction[] {
  const actions: SchedulerAction[] = [];
  const blockedTasksForRecovery = allTasks.filter(t => t.frontmatter.status === "blocked");

  for (const task of blockedTasksForRecovery) {
    const deps = task.frontmatter.dependsOn;
    const childTasks = childrenByParent.get(task.frontmatter.id) ?? [];
    const hasGate = deps.length > 0 || childTasks.length > 0;

    const blockReason = task.frontmatter.metadata?.blockReason as string | undefined;
    const isDispatchFailure = blockReason?.includes("spawn_failed") ?? false;

    if (isDispatchFailure) {
      const guard = shouldAllowSpawnFailedRequeue(task, maxRetries);

      if (guard.allow) {
        actions.push({
          type: "requeue",
          taskId: task.frontmatter.id,
          taskTitle: task.frontmatter.title,
          reason: `${guard.reason} after dispatch failure`,
        });
      } else if (guard.shouldDeadletter) {
        actions.push({
          type: "deadletter",
          taskId: task.frontmatter.id,
          taskTitle: task.frontmatter.title,
          reason: `${guard.reason} for dispatch failures — deadletter`,
        });
      }
      // If !allow && !shouldDeadletter, backoff pending — do nothing this cycle
      continue; // Skip dependency check for dispatch-failure tasks
    }

    // Dependency-based unblocking (existing logic)
    if (!hasGate) continue;

    const allDepsResolved = deps.every(depId => {
      const dep = allTasks.find(t => t.frontmatter.id === depId);
      return dep?.frontmatter.status === "done";
    });
    const allSubtasksResolved = childTasks.every(child => child.frontmatter.status === "done");

    if (allDepsResolved && allSubtasksResolved) {
      actions.push({
        type: "requeue",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "All dependencies resolved — can be requeued",
      });
    }
  }

  return actions;
}
