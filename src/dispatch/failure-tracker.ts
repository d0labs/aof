/**
 * Dispatch failure tracking and deadletter transitions.
 * 
 * Tracks dispatch failures in task metadata. After 3 failures,
 * transitions task to deadletter status and moves file to tasks/deadletter/.
 * 
 * See AOF-p3k task brief for requirements.
 */

import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { Task } from "../schemas/task.js";
import { serializeTask } from "../store/task-store.js";

const MAX_DISPATCH_FAILURES = 3;

/**
 * Track a dispatch failure for a task.
 * Increments dispatchFailures counter and records failure reason.
 */
export async function trackDispatchFailure(
  store: ITaskStore,
  taskId: string,
  reason: string
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const failures = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  
  // Update task metadata
  task.frontmatter.metadata.dispatchFailures = failures + 1;
  task.frontmatter.metadata.lastDispatchFailureReason = reason;
  task.frontmatter.metadata.lastDispatchFailureAt = Date.now();
  task.frontmatter.updatedAt = new Date().toISOString();

  // Write updated task back to file
  const filePath = task.path ?? join(store.tasksDir, task.frontmatter.status, `${taskId}.md`);
  await writeFileAtomic(filePath, serializeTask(task));
}

/**
 * Check if a task should transition to deadletter based on failure count.
 */
export function shouldTransitionToDeadletter(task: Task): boolean {
  const failures = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  return failures >= MAX_DISPATCH_FAILURES;
}

/**
 * Transition a task to deadletter status.
 * 
 * - Updates task status to "deadletter"
 * - Moves task file to tasks/deadletter/
 * - Logs deadletter event
 * - Emits ops alert (console + events.jsonl)
 */
export async function transitionToDeadletter(
  store: ITaskStore,
  eventLogger: EventLogger,
  taskId: string,
  lastFailureReason: string
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const failureCount = (task.frontmatter.metadata.dispatchFailures as number | undefined) ?? 0;
  const agent = task.frontmatter.routing?.agent;

  // Transition task to deadletter status
  await store.transition(taskId, "deadletter");

  // Log deadletter event
  await eventLogger.log("task.deadletter", "system", {
    taskId,
    payload: {
      reason: "max_dispatch_failures",
      failureCount,
      lastFailureReason,
    },
  });

  // Emit ops alert (console)
  // AOF-1m9: Mandatory ops alerting for deadletter transitions
  console.error(`[AOF] DEADLETTER: Task ${taskId} (${task.frontmatter.title})`);
  console.error(`[AOF] DEADLETTER:   Failure count: ${failureCount}`);
  console.error(`[AOF] DEADLETTER:   Last failure: ${lastFailureReason}`);
  console.error(`[AOF] DEADLETTER:   Agent: ${agent ?? "unassigned"}`);
  console.error(`[AOF] DEADLETTER:   Action: Investigate failure cause before resurrection`);
}

/**
 * Reset dispatch failure count (used when resurrecting a task).
 */
export async function resetDispatchFailures(
  store: ITaskStore,
  taskId: string
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Reset failure tracking
  task.frontmatter.metadata.dispatchFailures = 0;
  delete task.frontmatter.metadata.lastDispatchFailureReason;
  delete task.frontmatter.metadata.lastDispatchFailureAt;
  task.frontmatter.updatedAt = new Date().toISOString();

  // Write updated task back to file
  const filePath = task.path ?? join(store.tasksDir, task.frontmatter.status, `${taskId}.md`);
  await writeFileAtomic(filePath, serializeTask(task));
}
