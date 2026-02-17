/**
 * Helper functions for scheduler poll cycle.
 * 
 * Extracted to keep scheduler.ts focused on orchestration.
 */

import type { Task } from "../types.js";
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

/**
 * Check blocked tasks for unblocking/recovery.
 * Handles both dependency-based blocks and dispatch-failure retries.
 */
export function checkBlockedTaskRecovery(
  allTasks: Task[],
  childrenByParent: Map<string, Task[]>
): SchedulerAction[] {
  const actions: SchedulerAction[] = [];
  const blockedTasksForRecovery = allTasks.filter(t => t.frontmatter.status === "blocked");
  
  for (const task of blockedTasksForRecovery) {
    const deps = task.frontmatter.dependsOn;
    const childTasks = childrenByParent.get(task.frontmatter.id) ?? [];
    const hasGate = deps.length > 0 || childTasks.length > 0;

    // BUG-002: Check for dispatch failure recovery (tasks blocked due to spawn failures)
    const retryCount = (task.frontmatter.metadata?.retryCount as number) ?? 0;
    const lastBlockedAt = task.frontmatter.metadata?.lastBlockedAt as string | undefined;
    const blockReason = task.frontmatter.metadata?.blockReason as string | undefined;
    const maxRetries = 3; // Maximum retry attempts
    const retryDelayMs = 5 * 60 * 1000; // 5 minutes between retries

    // Check if this is a dispatch-failure block (not dependency-based)
    const isDispatchFailure = blockReason?.includes("spawn_failed") ?? false;

    if (isDispatchFailure && retryCount < maxRetries) {
      // Check if enough time has passed for retry
      if (lastBlockedAt) {
        const blockedAge = Date.now() - new Date(lastBlockedAt).getTime();
        if (blockedAge >= retryDelayMs) {
          actions.push({
            type: "requeue",
            taskId: task.frontmatter.id,
            taskTitle: task.frontmatter.title,
            reason: `Retry attempt ${retryCount + 1}/${maxRetries} after dispatch failure`,
          });
          continue; // Skip dependency check for dispatch-failure tasks
        }
      }
    } else if (isDispatchFailure && retryCount >= maxRetries) {
      // Max retries exceeded - emit alert
      actions.push({
        type: "alert",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: `Max retries (${maxRetries}) exceeded for dispatch failures — manual intervention required`,
      });
      continue; // Skip dependency check
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
