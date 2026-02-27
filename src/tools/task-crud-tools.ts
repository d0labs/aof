/**
 * AOF task CRUD tools — create, update, edit, cancel operations.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { TaskStatus, TaskPriority, Task } from "../schemas/task.js";
import { compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import type { ToolContext } from "./aof-tools.js";

async function resolveTask(store: ITaskStore, taskId: string) {
  const task = await store.get(taskId);
  if (task) return task;
  const byPrefix = await store.getByPrefix(taskId);
  if (byPrefix) return byPrefix;
  throw new Error(`Task not found: ${taskId}`);
}

// ===== TYPES =====

/**
 * Input for updating a task's body content and/or transitioning its status.
 */
export interface AOFTaskUpdateInput {
  /** Full or prefix task ID to update. */
  taskId: string;
  /** New markdown body content; replaces the existing body entirely. */
  body?: string;
  /** Target status to transition the task to. */
  status?: TaskStatus;
  /** Identity of the agent or user performing the update; defaults to "unknown". */
  actor?: string;
  /** Reason for the status transition, recorded in the event log. */
  reason?: string;
}

/**
 * Result of a task update operation, indicating what changed.
 */
export interface AOFTaskUpdateResult extends ToolResponseEnvelope {
  /** The resolved task ID. */
  taskId: string;
  /** The task's status after the update. */
  status: TaskStatus;
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string;
  /** Whether the task body was modified. */
  bodyUpdated: boolean;
  /** Whether a status transition occurred. */
  transitioned: boolean;
}

/**
 * Input for editing a task's frontmatter fields (title, priority, routing).
 */
export interface AOFTaskEditInput {
  /** Full or prefix task ID to edit. */
  taskId: string;
  /** New task title. */
  title?: string;
  /** New task description (body text). */
  description?: string;
  /** New priority level. */
  priority?: TaskPriority;
  /** Updated routing configuration (agent, team, role, tags). */
  routing?: {
    role?: string;
    team?: string;
    agent?: string;
    tags?: string[];
  };
  /** Identity of the agent or user performing the edit; defaults to "unknown". */
  actor?: string;
}

/**
 * Result of a task edit, listing which fields were modified.
 */
export interface AOFTaskEditResult extends ToolResponseEnvelope {
  /** The resolved task ID. */
  taskId: string;
  /** Names of frontmatter fields that were updated. */
  updatedFields: string[];
  /** Snapshot of key task fields after the edit. */
  task: {
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
  };
}

/**
 * Input for cancelling a task.
 */
export interface AOFTaskCancelInput {
  /** Full or prefix task ID to cancel. */
  taskId: string;
  /** Human-readable reason for cancellation, logged in the event stream. */
  reason?: string;
  /** Identity of the agent or user cancelling; defaults to "unknown". */
  actor?: string;
}

/**
 * Result of a task cancellation.
 */
export interface AOFTaskCancelResult extends ToolResponseEnvelope {
  /** The resolved task ID. */
  taskId: string;
  /** The task's status after cancellation (always "cancelled"). */
  status: TaskStatus;
  /** The cancellation reason, if provided. */
  reason?: string;
}

// ===== FUNCTIONS =====

/**
 * Update a task's body content and/or transition its lifecycle status.
 *
 * Resolves the task by full ID or prefix, optionally replaces the body,
 * and optionally transitions to a new status. Both operations are independent
 * and can be performed together or separately in a single call.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task ID, optional new body, optional target status
 * @returns Updated task state including whether body and/or status changed
 */
export async function aofTaskUpdate(
  ctx: ToolContext,
  input: AOFTaskUpdateInput,
): Promise<AOFTaskUpdateResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  let updatedTask = task;
  if (input.body !== undefined) {
    updatedTask = await ctx.store.updateBody(task.frontmatter.id, input.body);
  }

  let transitioned = false;
  if (input.status && input.status !== updatedTask.frontmatter.status) {
    const from = updatedTask.frontmatter.status;
    updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, input.status, {
      reason: input.reason,
      agent: actor,
    });
    await ctx.logger.logTransition(updatedTask.frontmatter.id, from, input.status, actor, input.reason);
    transitioned = true;
  }

  const actions = [];
  if (input.body !== undefined) actions.push("body updated");
  if (transitioned) actions.push(`→ ${updatedTask.frontmatter.status}`);
  const summary = `Task ${updatedTask.frontmatter.id} ${actions.join(", ")}`;

  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
    updatedAt: updatedTask.frontmatter.updatedAt,
    bodyUpdated: input.body !== undefined,
    transitioned,
  };
}

/**
 * Edit a task's frontmatter fields (title, description, priority, routing).
 *
 * At least one field must be provided. The task is resolved by full ID or
 * prefix, the specified fields are patched, and the updated frontmatter
 * is persisted. Throws if no fields are provided.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task ID and one or more fields to update
 * @returns List of updated field names and a snapshot of the task's current state
 */
export async function aofTaskEdit(
  ctx: ToolContext,
  input: AOFTaskEditInput,
): Promise<AOFTaskEditResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  // Build patch object
  const patch: {
    title?: string;
    description?: string;
    priority?: string;
    routing?: {
      role?: string;
      team?: string;
      agent?: string;
      tags?: string[];
    };
  } = {};

  const updatedFields: string[] = [];

  if (input.title !== undefined) {
    patch.title = input.title;
    updatedFields.push("title");
  }

  if (input.description !== undefined) {
    patch.description = input.description;
    updatedFields.push("description");
  }

  if (input.priority !== undefined) {
    patch.priority = input.priority;
    updatedFields.push("priority");
  }

  if (input.routing !== undefined) {
    patch.routing = input.routing;
    updatedFields.push("routing");
  }

  if (updatedFields.length === 0) {
    throw new Error("No fields to update. Provide at least one of: title, description, priority, routing");
  }

  const updatedTask = await ctx.store.update(task.frontmatter.id, patch);

  const summary = `Task ${updatedTask.frontmatter.id} updated: ${updatedFields.join(", ")}`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    updatedFields,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    updatedFields,
    task: {
      title: updatedTask.frontmatter.title,
      status: updatedTask.frontmatter.status,
      priority: updatedTask.frontmatter.priority,
    },
  };
}

/**
 * Cancel a task, moving it to the "cancelled" status.
 *
 * Resolves the task by full ID or prefix, delegates to store.cancel(),
 * and logs a task.cancelled event with the optional reason.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task ID and optional cancellation reason
 * @returns The cancelled task's ID, final status, and reason
 */
export async function aofTaskCancel(
  ctx: ToolContext,
  input: AOFTaskCancelInput,
): Promise<AOFTaskCancelResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  const cancelledTask = await ctx.store.cancel(task.frontmatter.id, input.reason);

  await ctx.logger.log("task.cancelled", actor, {
    taskId: cancelledTask.frontmatter.id,
    payload: { reason: input.reason },
  });

  const summary = input.reason
    ? `Task ${cancelledTask.frontmatter.id} cancelled: ${input.reason}`
    : `Task ${cancelledTask.frontmatter.id} cancelled`;

  const envelope = compactResponse(summary, {
    taskId: cancelledTask.frontmatter.id,
    status: cancelledTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: cancelledTask.frontmatter.id,
    status: cancelledTask.frontmatter.status,
    reason: input.reason,
  };
}
