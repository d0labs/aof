/**
 * Task promotion eligibility checking.
 * 
 * Determines whether a task is eligible to move from backlog to ready state.
 */

import type { Task } from "../types.js";
import { isLeaseActive } from "./lease-manager.js";

/**
 * Check if a task is eligible for promotion from backlog to ready.
 * 
 * A task is eligible if:
 * - All dependencies are done
 * - All subtasks are done
 * - It has a routing target (agent/role/team)
 * - It doesn't have an active lease
 * 
 * @param task - Task to check
 * @param allTasks - All tasks in the project (for dependency lookup)
 * @param childrenByParent - Map of parent ID to child tasks
 * @returns Object with eligible flag and optional reason
 */
export function checkPromotionEligibility(
  task: Task,
  allTasks: Task[],
  childrenByParent: Map<string, Task[]>
): { eligible: boolean; reason?: string } {
  
  // 1. Check dependencies
  const deps = task.frontmatter.dependsOn ?? [];
  if (deps.length > 0) {
    for (const depId of deps) {
      const dep = allTasks.find(t => t.frontmatter.id === depId);
      if (!dep) {
        return { eligible: false, reason: `Missing dependency: ${depId}` };
      }
      if (dep.frontmatter.status !== "done") {
        return { eligible: false, reason: `Waiting on dependency: ${depId}` };
      }
    }
  }

  // 2. Check subtasks (parentId references)
  const subtasks = childrenByParent.get(task.frontmatter.id) ?? [];
  const incompleteSubtasks = subtasks.filter(st => st.frontmatter.status !== "done");
  if (incompleteSubtasks.length > 0) {
    return { 
      eligible: false, 
      reason: `Waiting on ${incompleteSubtasks.length} subtask(s)` 
    };
  }

  // 3. Check routing target
  const routing = task.frontmatter.routing;
  const hasTarget = routing.agent || routing.role || routing.team;
  if (!hasTarget) {
    return { 
      eligible: false, 
      reason: "No routing target (needs agent/role/team)" 
    };
  }

  // 4. Check active lease (shouldn't happen in backlog, but safety check)
  if (isLeaseActive(task.frontmatter.lease)) {
    return { 
      eligible: false, 
      reason: "Active lease (corrupted state?)" 
    };
  }

  // 5. Future: Check approval gate (Phase 2)
  // const requiresApproval = task.frontmatter.metadata?.requiresApproval;
  // if (requiresApproval) {
  //   return { eligible: false, reason: "Requires manual approval" };
  // }

  return { eligible: true };
}
