/**
 * AOF project tools — task creation and dispatch operations.
 */

import type { TaskStatus, TaskPriority } from "../schemas/task.js";
import { compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import type { ToolContext } from "./aof-tools.js";

export interface AOFDispatchInput {
  title: string;
  brief: string;
  description?: string;
  agent?: string;
  team?: string;
  role?: string;
  priority?: TaskPriority | "normal";
  dependsOn?: string[];
  parentId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  actor?: string;
}

export interface AOFDispatchResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  filePath: string;
}

function normalizePriority(priority?: string): TaskPriority {
  if (!priority) return "normal";
  const normalized = priority.toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "low") {
    return normalized as TaskPriority;
  }
  return "normal";
}

export async function aofDispatch(
  ctx: ToolContext,
  input: AOFDispatchInput,
): Promise<AOFDispatchResult> {
  const actor = input.actor ?? "unknown";

  // Validate required fields
  if (!input.title || input.title.trim().length === 0) {
    throw new Error("Task title is required");
  }

  const brief = input.brief || input.description || "";
  if (!brief || brief.trim().length === 0) {
    throw new Error("Task brief/description is required");
  }

  // Normalize priority
  const priority = normalizePriority(input.priority);

  // Build metadata
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.tags) {
    metadata.tags = input.tags;
  }

  // Create task with TaskStore.create
  const task = await ctx.store.create({
    title: input.title.trim(),
    body: brief.trim(),
    priority,
    routing: {
      agent: input.agent,
      team: input.team,
      role: input.role,
    },
    dependsOn: input.dependsOn,
    parentId: input.parentId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    createdBy: actor,
  });

  // Log task.created event
  await ctx.logger.log("task.created", actor, {
    taskId: task.frontmatter.id,
    payload: {
      title: task.frontmatter.title,
      priority: task.frontmatter.priority,
      routing: task.frontmatter.routing,
    },
  });

  // Transition to ready status
  const readyTask = await ctx.store.transition(task.frontmatter.id, "ready", {
    agent: actor,
    reason: "task_dispatch",
  });

  // Log transition
  await ctx.logger.logTransition(
    task.frontmatter.id,
    "backlog",
    "ready",
    actor,
    "task_dispatch"
  );

  // Build response envelope
  const summary = `Task ${readyTask.frontmatter.id} created and ready for assignment`;
  const envelope = compactResponse(summary, {
    taskId: readyTask.frontmatter.id,
    status: readyTask.frontmatter.status,
  });

  // Ensure filePath is always defined (construct if needed)
  const filePath = readyTask.path ?? `tasks/${readyTask.frontmatter.status}/${readyTask.frontmatter.id}.md`;

  return {
    ...envelope,
    taskId: readyTask.frontmatter.id,
    status: readyTask.frontmatter.status,
    filePath,
  };
}
