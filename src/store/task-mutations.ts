/**
 * Task mutation operations — extracted from task-store for modularity.
 * 
 * These are standalone functions that can be called by the store.
 * They accept store methods as parameters to avoid circular dependencies.
 */

import writeFileAtomic from "write-file-atomic";
import type { Task, TaskStatus } from "../schemas/task.js";
import { contentHash, serializeTask } from "./task-parser.js";

export interface UpdatePatch {
  title?: string;
  description?: string;
  priority?: string;
  routing?: {
    role?: string;
    team?: string;
    agent?: string;
    tags?: string[];
  };
}

/**
 * Update task fields (title, description, priority, routing).
 * Standalone function extracted from FilesystemTaskStore.update().
 */
export async function updateTask(
  id: string,
  patch: UpdatePatch,
  getTask: (id: string) => Promise<Task | null>,
  getTaskPath: (id: string, status: TaskStatus) => string,
  logger?: {
    log(event: string, actor: string, data: { taskId: string; payload: unknown }): Promise<void>;
  },
): Promise<Task> {
  const task = await getTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  // Reject updates to terminal states
  const terminalStates: TaskStatus[] = ["done"];
  if (terminalStates.includes(task.frontmatter.status)) {
    throw new Error(
      `Cannot update task ${id}: task is in terminal state '${task.frontmatter.status}'`,
    );
  }

  // Track what changed for event payload
  const changes: Record<string, unknown> = {};

  // Apply patches
  if (patch.title !== undefined) {
    changes.title = { from: task.frontmatter.title, to: patch.title };
    task.frontmatter.title = patch.title;
  }

  if (patch.description !== undefined) {
    changes.description = { from: task.body, to: patch.description };
    task.body = patch.description;
    task.frontmatter.contentHash = contentHash(patch.description);
  }

  if (patch.priority !== undefined) {
    changes.priority = { from: task.frontmatter.priority, to: patch.priority };
    task.frontmatter.priority = patch.priority;
  }

  if (patch.routing !== undefined) {
    const oldRouting = { ...task.frontmatter.routing };
    
    if (patch.routing.role !== undefined) {
      task.frontmatter.routing.role = patch.routing.role;
    }
    if (patch.routing.team !== undefined) {
      task.frontmatter.routing.team = patch.routing.team;
    }
    if (patch.routing.agent !== undefined) {
      task.frontmatter.routing.agent = patch.routing.agent;
    }
    if (patch.routing.tags !== undefined) {
      task.frontmatter.routing.tags = patch.routing.tags;
    }

    changes.routing = { from: oldRouting, to: task.frontmatter.routing };
  }

  // Update timestamp
  task.frontmatter.updatedAt = new Date().toISOString();

  // Persist changes
  const filePath = task.path ?? getTaskPath(id, task.frontmatter.status);
  await writeFileAtomic(filePath, serializeTask(task));

  // Emit task.updated event
  if (logger && Object.keys(changes).length > 0) {
    await logger.log("task.updated", "system", {
      taskId: id,
      payload: { changes },
    });
  }

  return task;
}
