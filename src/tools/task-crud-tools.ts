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

export interface AOFTaskUpdateInput {
  taskId: string;
  body?: string;
  status?: TaskStatus;
  actor?: string;
  reason?: string;
}

export interface AOFTaskUpdateResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  updatedAt: string;
  bodyUpdated: boolean;
  transitioned: boolean;
}

export interface AOFTaskEditInput {
  taskId: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  routing?: {
    role?: string;
    team?: string;
    agent?: string;
    tags?: string[];
  };
  actor?: string;
}

export interface AOFTaskEditResult extends ToolResponseEnvelope {
  taskId: string;
  updatedFields: string[];
  task: {
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
  };
}

export interface AOFTaskCancelInput {
  taskId: string;
  reason?: string;
  actor?: string;
}

export interface AOFTaskCancelResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  reason?: string;
}

// ===== FUNCTIONS =====

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
