/**
 * Task lifecycle operations (block, unblock, cancel).
 * 
 * Functions for managing task state transitions and metadata.
 * Extracted from FilesystemTaskStore to keep it under size limits.
 */

import { rename } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { EventLogger } from "../events/logger.js";
import { serializeTask } from "./task-parser.js";
import type { TaskStoreHooks } from "./task-store.js";

/**
 * Task getter function type.
 */
export type TaskGetter = (id: string) => Promise<Task | undefined>;

/**
 * Task transition function type.
 */
export type TaskTransition = (id: string, newStatus: TaskStatus, opts?: { reason?: string; agent?: string }) => Promise<Task>;

/**
 * Task path resolver function type.
 */
export type TaskPathResolver = (id: string, status: TaskStatus) => string;

/**
 * Task directory resolver function type.
 */
export type TaskDirResolver = (id: string, status: TaskStatus) => string;

/**
 * Block a task with a reason.
 * Transitions task to blocked state and stores the block reason.
 * Can only block tasks from non-terminal states.
 * 
 * @param id - Task ID
 * @param reason - Block reason
 * @param getTask - Function to fetch task by ID
 * @param transition - Function to transition task
 * @param taskPath - Function to resolve task path
 * @param logger - Optional event logger
 * @returns Updated blocked task
 */
export async function blockTask(
  id: string,
  reason: string,
  getTask: TaskGetter,
  transition: TaskTransition,
  taskPath: TaskPathResolver,
  logger?: EventLogger,
): Promise<Task> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const currentStatus = task.frontmatter.status;

  // Cannot block if already blocked
  if (currentStatus === "blocked") {
    throw new Error(`Task ${id} is already blocked`);
  }

  // Terminal states cannot be blocked (done, cancelled, deadletter)
  const terminalStates: TaskStatus[] = ["done", "cancelled", "deadletter"];
  if (terminalStates.includes(currentStatus)) {
    throw new Error(`Cannot block task ${id} in terminal state: ${currentStatus}`);
  }

  // Store block reason in metadata
  task.frontmatter.metadata.blockReason = reason;

  // First update the metadata, then transition
  const filePath = task.path ?? taskPath(id, currentStatus);
  await writeFileAtomic(filePath, serializeTask(task));

  // Transition to blocked state
  const blockedTask = await transition(id, "blocked");

  // Emit task.blocked event
  if (logger) {
    await logger.log("task.blocked", "system", {
      taskId: id,
      payload: { reason },
    });
  }

  return blockedTask;
}

/**
 * Unblock a task.
 * Transitions task from blocked to ready and clears the block reason.
 * Can only unblock tasks currently in blocked state.
 * 
 * @param id - Task ID
 * @param getTask - Function to fetch task by ID
 * @param transition - Function to transition task
 * @param taskPath - Function to resolve task path
 * @param logger - Optional event logger
 * @returns Updated unblocked task
 */
export async function unblockTask(
  id: string,
  getTask: TaskGetter,
  transition: TaskTransition,
  taskPath: TaskPathResolver,
  logger?: EventLogger,
): Promise<Task> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const currentStatus = task.frontmatter.status;

  // Can only unblock tasks that are currently blocked
  if (currentStatus !== "blocked") {
    throw new Error(`Cannot unblock task ${id} that is not blocked (current status: ${currentStatus})`);
  }

  // Clear block reason and retry count from metadata (XRAY-006)
  delete task.frontmatter.metadata.blockReason;
  delete task.frontmatter.metadata.retryCount;

  // First update the metadata, then transition
  const filePath = task.path ?? taskPath(id, currentStatus);
  await writeFileAtomic(filePath, serializeTask(task));

  // Transition to ready state
  const readyTask = await transition(id, "ready");

  // Emit task.unblocked event
  if (logger) {
    await logger.log("task.unblocked", "system", {
      taskId: id,
      payload: {},
    });
  }

  return readyTask;
}

/**
 * Cancel a task.
 * Transitions to "cancelled" status, clears any active lease,
 * stores cancellation reason in metadata, and emits task.cancelled event.
 * 
 * @param id - Task ID
 * @param reason - Optional cancellation reason
 * @param getTask - Function to fetch task by ID
 * @param taskPath - Function to resolve task path
 * @param taskDir - Function to resolve task directory
 * @param logger - Optional event logger
 * @param hooks - Optional store hooks
 * @returns Updated cancelled task
 */
export async function cancelTask(
  id: string,
  reason: string | undefined,
  getTask: TaskGetter,
  taskPath: TaskPathResolver,
  taskDir: TaskDirResolver,
  logger?: EventLogger,
  hooks?: TaskStoreHooks,
): Promise<Task> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const currentStatus = task.frontmatter.status;

  // Reject cancellation of already-terminal tasks
  if (currentStatus === "done" || currentStatus === "cancelled") {
    throw new Error(
      `Cannot cancel task ${id}: already in terminal state '${currentStatus}'`,
    );
  }

  // Store cancellation reason in metadata
  if (reason) {
    task.frontmatter.metadata = {
      ...task.frontmatter.metadata,
      cancellationReason: reason,
    };
  }

  const now = new Date().toISOString();
  task.frontmatter.status = "cancelled";
  task.frontmatter.updatedAt = now;
  task.frontmatter.lastTransitionAt = now;

  // Clear any active lease
  if (task.frontmatter.lease) {
    task.frontmatter.lease = undefined;
  }

  const oldPath = task.path ?? taskPath(id, currentStatus);
  const newPath = taskPath(id, "cancelled");

  if (oldPath !== newPath) {
    // Atomic transition: write to old location first, then rename
    await writeFileAtomic(oldPath, serializeTask(task));
    
    // Atomic move to new location
    await rename(oldPath, newPath);

    // Move companion directories if present
    const oldDir = taskDir(id, currentStatus);
    const newDir = taskDir(id, "cancelled");
    try {
      await rename(oldDir, newDir);
    } catch {
      // Companion directory missing — ignore
    }
  } else {
    // Same location, just update content atomically
    await writeFileAtomic(newPath, serializeTask(task));
  }

  task.path = newPath;
  
  // Emit task.cancelled event
  if (logger) {
    await logger.log("task.cancelled", "system", {
      taskId: id,
      payload: { reason, from: currentStatus },
    });
  }

  if (hooks?.afterTransition) {
    await hooks.afterTransition(task, currentStatus);
  }

  return task;
}
