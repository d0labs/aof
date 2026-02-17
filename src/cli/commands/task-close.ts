/**
 * task close command — close a task (transition to done).
 * 
 * Supports --recover-on-failure flag for automatic recovery on failure.
 */

import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import { attemptRecovery, formatRecoverySummary } from "../recovery.js";

export interface TaskCloseOptions {
  recoverOnFailure?: boolean;
}

/**
 * Close a task (transition to done status).
 * 
 * @param store - Task store
 * @param eventLogger - Event logger
 * @param taskId - Task ID to close
 * @param options - Command options
 */
export async function taskClose(
  store: ITaskStore,
  eventLogger: EventLogger,
  taskId: string,
  options: TaskCloseOptions = {}
): Promise<void> {
  try {
    // Attempt to close task
    await store.transition(taskId, "done", {
      reason: "closed_via_cli",
      agent: "cli",
    });
    
    console.log(`✅ Task ${taskId} closed`);
  } catch (err) {
    const error = err as Error;
    console.error(`❌ Failed to close ${taskId}: ${error.message}`);
    
    if (options.recoverOnFailure) {
      // Attempt recovery
      const recovery = await attemptRecovery(store, eventLogger, taskId);
      console.log(formatRecoverySummary(recovery));
      
      if (recovery.recovered) {
        console.log(`\nRetry: aof task close ${taskId}`);
      } else {
        process.exitCode = 1;
      }
    } else {
      process.exitCode = 1;
    }
  }
}
