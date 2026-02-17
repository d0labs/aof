/**
 * task promote command — promote a task from backlog to ready.
 * 
 * Validates promotion eligibility unless --force is used.
 */

import type { TaskStore } from "../../store/task-store.js";
import type { EventLogger } from "../../events/logger.js";
import type { Task } from "../../schemas/task.js";

export interface TaskPromoteOptions {
  force?: boolean;
}

/**
 * Check if a task is eligible for promotion.
 * Reused by CLI and scheduler.
 */
export function checkPromotionEligibility(
  task: Task,
  allTasks: Task[],
  childrenByParent: Map<string, Task[]>
): { eligible: boolean; reason?: string } {
  
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

  const subtasks = childrenByParent.get(task.frontmatter.id) ?? [];
  const incompleteSubtasks = subtasks.filter(st => st.frontmatter.status !== "done");
  if (incompleteSubtasks.length > 0) {
    return { 
      eligible: false, 
      reason: `Waiting on ${incompleteSubtasks.length} subtask(s)` 
    };
  }

  const routing = task.frontmatter.routing;
  const hasTarget = routing.agent || routing.role || routing.team;
  if (!hasTarget) {
    return { 
      eligible: false, 
      reason: "No routing target (needs agent/role/team)" 
    };
  }

  const lease = task.frontmatter.lease;
  if (lease) {
    const expiresAt = new Date(lease.expiresAt).getTime();
    if (expiresAt > Date.now()) {
      return { 
        eligible: false, 
        reason: "Active lease (corrupted state?)" 
      };
    }
  }

  return { eligible: true };
}

/**
 * Build a map of parent ID to child tasks.
 */
function buildChildrenMap(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const parentId = task.frontmatter.parentId;
    if (!parentId) continue;
    const list = map.get(parentId) ?? [];
    list.push(task);
    map.set(parentId, list);
  }
  return map;
}

/**
 * Promote a task from backlog to ready.
 * 
 * @param store - Task store
 * @param eventLogger - Event logger
 * @param taskId - Task ID to promote
 * @param options - Command options
 */
export async function taskPromote(
  store: TaskStore,
  eventLogger: EventLogger,
  taskId: string,
  options: TaskPromoteOptions = {}
): Promise<void> {
  // Load task
  const task = await store.get(taskId);
  
  if (!task) {
    console.error(`❌ Task not found: ${taskId}`);
    process.exit(1);
  }
  
  if (task.frontmatter.status !== "backlog") {
    console.error(`❌ Task ${taskId} is not in backlog (current: ${task.frontmatter.status})`);
    process.exit(1);
  }
  
  // Check eligibility unless forced
  if (!options.force) {
    const allTasks = await store.list();
    const childrenByParent = buildChildrenMap(allTasks);
    const check = checkPromotionEligibility(task, allTasks, childrenByParent);
    
    if (!check.eligible) {
      console.error(`❌ Cannot promote: ${check.reason}`);
      console.error(`   Use --force to override`);
      process.exit(1);
    }
  }
  
  // Perform transition
  await store.transition(taskId, "ready", {
    agent: "cli",
    reason: options.force ? "Manual promotion (forced)" : "Manual promotion",
  });
  
  console.log(`✅ Promoted ${taskId} → ready`);
}
