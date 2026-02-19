/**
 * Protocol router helper functions.
 * 
 * Extracted from router.ts to meet size budget.
 */

import type { Task } from "../schemas/task.js";
import type { TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { NotificationService } from "../events/notifier.js";
import type { ProtocolLogger } from "./parsers.js";
import type { StatusUpdatePayload } from "../schemas/protocol.js";
import { isValidTransition } from "../schemas/task.js";
import { buildCompletionReason } from "./formatters.js";
import { resolveCompletionTransitions } from "./completion-utils.js";
import type { RunResult } from "../schemas/run-result.js";

/**
 * Resolve the authorized agent for a task (from lease or routing).
 */
export function resolveAuthorizedAgent(task: Task): string | undefined {
  return task.frontmatter.lease?.agent ?? task.frontmatter.routing?.agent;
}

/**
 * Check if the sender is authorized to send protocol messages for this task.
 */
export async function checkAuthorization(
  fromAgent: string,
  taskId: string,
  task: Task,
  logger?: ProtocolLogger,
): Promise<boolean> {
  const authorizedAgent = resolveAuthorizedAgent(task);
  if (!authorizedAgent) {
    await logger?.log("protocol.message.rejected", "system", {
      taskId,
      payload: { reason: "unassigned_task", sender: fromAgent }
    });
    return false;
  }
  if (fromAgent !== authorizedAgent) {
    await logger?.log("protocol.message.rejected", "system", {
      taskId,
      payload: { reason: "unauthorized_agent", expected: authorizedAgent, received: fromAgent }
    });
    return false;
  }
  return true;
}

/**
 * Apply completion outcome transitions to a task.
 */
export async function applyCompletionOutcome(
  task: Task,
  opts: {
    actor: string;
    outcome: RunResult["outcome"];
    notes?: string;
    blockers?: string[];
  },
  store: ITaskStore,
  logger?: ProtocolLogger,
  notifier?: NotificationService,
): Promise<void> {
  const transitions = resolveCompletionTransitions(task, opts.outcome);
  if (transitions.length === 0) return;

  let current = task;
  for (const nextStatus of transitions) {
    if (current.frontmatter.status === nextStatus) continue;
    if (!isValidTransition(current.frontmatter.status, nextStatus)) continue;
    const previousStatus = current.frontmatter.status;
    current = await transitionTask(current, nextStatus, opts.actor, buildCompletionReason(opts), store);
    if (current.frontmatter.status !== previousStatus) {
      await logTransition(
        current.frontmatter.id,
        previousStatus,
        current.frontmatter.status,
        opts.actor,
        buildCompletionReason(opts),
        logger,
      );
      // notifyTransition() removed — engine handles notifications via EventLogger.onEvent
    }
  }
}

/**
 * Transition a task to a new status if valid.
 */
export async function transitionTask(
  task: Task,
  status: TaskStatus,
  actor: string,
  reason: string | undefined,
  store: ITaskStore,
): Promise<Task> {
  if (task.frontmatter.status === status) return task;
  if (!isValidTransition(task.frontmatter.status, status)) return task;
  return store.transition(task.frontmatter.id, status, { reason, agent: actor });
}

/**
 * Log a task transition.
 */
export async function logTransition(
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  actor: string,
  reason: string | undefined,
  logger?: ProtocolLogger,
): Promise<void> {
  await logger?.log("task.transitioned", actor, {
    taskId,
    payload: { from, to, reason },
  });
}

/**
 * Notify about a task transition (only for review, blocked, done).
 */
export async function notifyTransition(
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  actor: string,
  reason: string | undefined,
  notifier?: NotificationService,
): Promise<void> {
  if (!notifier) return;
  if (to !== "review" && to !== "blocked" && to !== "done") return;
  await notifier.notify({
    eventId: Date.now(),
    type: "task.transitioned",
    timestamp: new Date().toISOString(),
    actor,
    taskId,
    payload: { from, to, reason },
  });
}
