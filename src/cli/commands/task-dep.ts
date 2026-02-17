/**
 * task dep commands — manage task dependencies.
 * 
 * Supports adding and removing blockers for tasks.
 */

import type { ITaskStore } from "../../store/interfaces.js";

/**
 * Add a dependency (blocker) to a task.
 * 
 * @param store - Task store
 * @param taskId - Task ID that will depend on the blocker
 * @param blockerId - Blocker task ID
 */
export async function taskDepAdd(
  store: ITaskStore,
  taskId: string,
  blockerId: string
): Promise<void> {
  try {
    // Resolve task IDs by prefix
    const task = await store.getByPrefix(taskId);
    if (!task) {
      console.error(`❌ Task not found: ${taskId}`);
      process.exitCode = 1;
      return;
    }

    const blocker = await store.getByPrefix(blockerId);
    if (!blocker) {
      console.error(`❌ Blocker task not found: ${blockerId}`);
      process.exitCode = 1;
      return;
    }

    const fullTaskId = task.frontmatter.id;
    const fullBlockerId = blocker.frontmatter.id;

    // Add dependency
    await store.addDep(fullTaskId, fullBlockerId);

    console.log(`✅ Added dependency: ${fullTaskId} now depends on ${fullBlockerId}`);
    console.log(`   Task: ${task.frontmatter.title}`);
    console.log(`   Blocker: ${blocker.frontmatter.title}`);
  } catch (error) {
    const errorMessage = (error as Error).message;
    
    if (errorMessage.includes("cannot depend on itself")) {
      console.error(`❌ Task cannot depend on itself`);
    } else if (errorMessage.includes("circular dependency")) {
      console.error(`❌ Cannot add dependency: would create a circular dependency`);
    } else if (errorMessage.includes("terminal state")) {
      console.error(`❌ Cannot modify dependencies: task is in terminal state`);
    } else if (errorMessage.includes("not found")) {
      console.error(`❌ ${errorMessage}`);
    } else {
      console.error(`❌ Failed to add dependency: ${errorMessage}`);
    }
    
    process.exitCode = 1;
  }
}

/**
 * Remove a dependency (blocker) from a task.
 * 
 * @param store - Task store
 * @param taskId - Task ID to remove dependency from
 * @param blockerId - Blocker task ID to remove
 */
export async function taskDepRemove(
  store: ITaskStore,
  taskId: string,
  blockerId: string
): Promise<void> {
  try {
    // Resolve task ID by prefix
    const task = await store.getByPrefix(taskId);
    if (!task) {
      console.error(`❌ Task not found: ${taskId}`);
      process.exitCode = 1;
      return;
    }

    const fullTaskId = task.frontmatter.id;

    // Note: removeDep doesn't validate blocker exists (it just removes from the array)
    // But we'll try to resolve it for a better message
    const blocker = await store.getByPrefix(blockerId);
    const fullBlockerId = blocker?.frontmatter.id ?? blockerId;

    // Remove dependency
    await store.removeDep(fullTaskId, fullBlockerId);

    console.log(`✅ Removed dependency: ${fullTaskId} no longer depends on ${fullBlockerId}`);
    console.log(`   Task: ${task.frontmatter.title}`);
    if (blocker) {
      console.log(`   Former blocker: ${blocker.frontmatter.title}`);
    }
  } catch (error) {
    const errorMessage = (error as Error).message;
    
    if (errorMessage.includes("terminal state")) {
      console.error(`❌ Cannot modify dependencies: task is in terminal state`);
    } else if (errorMessage.includes("not found")) {
      console.error(`❌ ${errorMessage}`);
    } else {
      console.error(`❌ Failed to remove dependency: ${errorMessage}`);
    }
    
    process.exitCode = 1;
  }
}
