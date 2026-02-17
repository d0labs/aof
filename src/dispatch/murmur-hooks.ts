/**
 * Murmur hooks for task store — track completions and failures for orchestration triggers.
 *
 * Hooks into task transitions to update murmur state counters.
 * Called by task store after each status transition.
 */

import type { Task, TaskStatus } from "../schemas/task.js";
import { MurmurStateManager } from "../murmur/state-manager.js";
import { join } from "node:path";

/**
 * Create a murmur afterTransition hook for the task store.
 *
 * This hook tracks:
 * - Task completions (transitions to "done")
 * - Task failures (transitions to "deadletter")
 * - Review task completions (orchestration_review kind)
 *
 * @param projectRoot - Project root directory for state files
 * @param stateManager - Optional state manager instance (created if not provided)
 * @returns Hook function for task store
 */
export function createMurmurHook(
  projectRoot: string,
  stateManager?: MurmurStateManager
): (task: Task, previousStatus: TaskStatus) => Promise<void> {
  const manager =
    stateManager ??
    new MurmurStateManager({
      stateDir: join(projectRoot, ".murmur"),
    });

  return async (task: Task, previousStatus: TaskStatus) => {
    const currentStatus = task.frontmatter.status;
    const team = task.frontmatter.routing.team;
    
    // Skip if no team assignment
    if (!team) {
      return;
    }

    try {
      // Track completions: tasks transitioning to "done"
      if (currentStatus === "done" && previousStatus !== "done") {
        // Check if this is a murmur review task
        const isMurmurReview =
          task.frontmatter.metadata?.kind === "orchestration_review";

        if (isMurmurReview) {
          // End the review cycle for this team
          await manager.endReview(team);
        } else {
          // Regular task completion — increment counter
          await manager.incrementCompletions(team);
        }
      }

      // Track failures: tasks transitioning to "deadletter"
      if (currentStatus === "deadletter" && previousStatus !== "deadletter") {
        await manager.incrementFailures(team);
      }
    } catch (error) {
      // Murmur state updates should not crash the task store
      console.error(
        `[AOF] Murmur hook error for task ${task.frontmatter.id}: ${(error as Error).message}`
      );
    }
  };
}
