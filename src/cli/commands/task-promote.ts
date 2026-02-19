/**
 * task promote command — promote a task from backlog to ready.
 * 
 * Validates promotion eligibility unless --force is used.
 */

import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import type { Task } from "../../schemas/task.js";
import { checkPromotionEligibility } from "../../dispatch/promotion.js";

export interface TaskPromoteOptions {
  force?: boolean;
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
  store: ITaskStore,
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
