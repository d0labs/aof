/**
 * AOF project tools — task creation and dispatch operations.
 */

import type { TaskStatus, TaskPriority } from "../schemas/task.js";
import { compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import type { ToolContext } from "./aof-tools.js";

/**
 * Input parameters for creating and dispatching a new task.
 */
export interface AOFDispatchInput {
  /** Human-readable task title (required). */
  title: string;
  /** Short summary of what the task entails (required). */
  brief: string;
  /** Extended description; used as fallback for brief if brief is empty. */
  description?: string;
  /** Agent ID to route the task to. */
  agent?: string;
  /** Team ID for team-based routing. */
  team?: string;
  /** Role identifier for role-based routing. */
  role?: string;
  /** Task priority; defaults to "normal" if omitted or unrecognized. */
  priority?: TaskPriority | "normal";
  /** Task IDs that must complete before this task becomes dispatchable. */
  dependsOn?: string[];
  /** Parent task ID for subtask hierarchies. */
  parentId?: string;
  /** Arbitrary key-value metadata attached to the task frontmatter. */
  metadata?: Record<string, unknown>;
  /** Tags merged into metadata for categorization and filtering. */
  tags?: string[];
  /** Identity of the agent or user creating the task; defaults to "unknown". */
  actor?: string;
}

/**
 * Result returned after a task is successfully created and dispatched.
 */
export interface AOFDispatchResult extends ToolResponseEnvelope {
  /** The generated unique task identifier (e.g. TASK-2026-02-17-001). */
  taskId: string;
  /** The task's current status after dispatch (typically "ready"). */
  status: TaskStatus;
  /** Filesystem path where the task markdown file resides. */
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

/**
 * Create a new task and immediately transition it to "ready" for dispatch.
 *
 * Validates required fields (title, brief), normalizes priority, persists
 * the task via the store, logs creation and transition events, and returns
 * a response envelope with the new task ID and file path.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task creation parameters (title, brief, routing, etc.)
 * @returns The created task's ID, status, and file path wrapped in a response envelope
 */
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
