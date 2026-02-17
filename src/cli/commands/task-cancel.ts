/**
 * task cancel command — cancel a task with optional reason.
 * 
 * Transitions task to cancelled status and stores cancellation reason.
 */

import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";

export interface TaskCancelOptions {
  reason?: string;
}

/**
 * Cancel a task.
 * 
 * @param store - Task store
 * @param eventLogger - Event logger (unused, kept for consistency)
 * @param taskId - Task ID to cancel
 * @param options - Command options
 */
export async function taskCancel(
  store: ITaskStore,
  eventLogger: EventLogger,
  taskId: string,
  options: TaskCancelOptions = {}
): Promise<void> {
  // Resolve task by prefix
  const task = await store.getByPrefix(taskId);
  
  if (!task) {
    console.error(`❌ Task not found: ${taskId}`);
    process.exit(1);
    return; // Never reached, but satisfies TypeScript
  }
  
  const fullId = task.frontmatter.id;
  const currentStatus = task.frontmatter.status;
  
  // Store.cancel() will throw if already terminal, so we can just call it
  try {
    await store.cancel(fullId, options.reason);
    
    console.log(`✅ Task cancelled: ${fullId}`);
    console.log(`   Previous status: ${currentStatus}`);
    if (options.reason) {
      console.log(`   Reason: ${options.reason}`);
    }
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  }
}
