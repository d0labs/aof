/**
 * task edit command — edit task metadata.
 * 
 * Supports updating: title, description, priority, routing (assignee, team).
 */

import type { ITaskStore } from "../../store/interfaces.js";

export interface TaskEditOptions {
  title?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  team?: string;
}

/**
 * Edit a task's metadata.
 * 
 * @param store - Task store
 * @param taskId - Task ID to edit
 * @param options - Fields to update
 */
export async function taskEdit(
  store: ITaskStore,
  taskId: string,
  options: TaskEditOptions
): Promise<void> {
  try {
    // Build the patch object with only specified fields
    const patch: {
      title?: string;
      description?: string;
      priority?: string;
      routing?: {
        agent?: string;
        team?: string;
      };
    } = {};

    if (options.title !== undefined) {
      patch.title = options.title;
    }
    if (options.description !== undefined) {
      patch.description = options.description;
    }
    if (options.priority !== undefined) {
      patch.priority = options.priority;
    }
    if (options.assignee !== undefined || options.team !== undefined) {
      patch.routing = {};
      if (options.assignee !== undefined) {
        patch.routing.agent = options.assignee;
      }
      if (options.team !== undefined) {
        patch.routing.team = options.team;
      }
    }

    const updated = await store.update(taskId, patch);

    console.log(`✅ Task updated: ${updated.frontmatter.id}`);
    if (options.title !== undefined) {
      console.log(`   Title: ${updated.frontmatter.title}`);
    }
    if (options.priority !== undefined) {
      console.log(`   Priority: ${updated.frontmatter.priority}`);
    }
    if (options.assignee !== undefined) {
      console.log(`   Assignee: ${updated.frontmatter.routing.agent ?? "(none)"}`);
    }
    if (options.team !== undefined) {
      console.log(`   Team: ${updated.frontmatter.routing.team ?? "(none)"}`);
    }
    if (options.description !== undefined) {
      console.log(`   Description: ${updated.body.substring(0, 60)}${updated.body.length > 60 ? "..." : ""}`);
    }
  } catch (error) {
    const errorMessage = (error as Error).message;
    if (errorMessage.includes("not found")) {
      console.error(`❌ Task not found: ${taskId}`);
    } else if (errorMessage.includes("terminal state")) {
      console.error(`❌ Cannot edit task in terminal state (done): ${taskId}`);
    } else {
      console.error(`❌ Failed to update task: ${errorMessage}`);
    }
    process.exitCode = 1;
  }
}
