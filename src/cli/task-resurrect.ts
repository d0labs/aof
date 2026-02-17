/**
 * Task resurrection command — transition deadletter → ready.
 * 
 * Moves task file from tasks/deadletter/ back to tasks/ready/,
 * resets dispatch failure count, and logs resurrection event.
 * 
 * See AOF-p3k task brief for requirements.
 */

import type { TaskStore } from "../store/task-store.js";
import type { EventLogger } from "../events/logger.js";
import { resetDispatchFailures } from "../dispatch/failure-tracker.js";

/**
 * Resurrect a task from deadletter status back to ready.
 * 
 * @param store - Task store
 * @param eventLogger - Event logger
 * @param taskId - Task ID to resurrect
 * @param userName - User performing the resurrection
 */
export async function resurrectTask(
  store: TaskStore,
  eventLogger: EventLogger,
  taskId: string,
  userName: string
): Promise<void> {
  // Load task from deadletter
  const task = await store.get(taskId);
  
  if (!task || task.frontmatter.status !== "deadletter") {
    throw new Error(`Task ${taskId} not found in deadletter queue`);
  }

  // Reset dispatch failure count
  await resetDispatchFailures(store, taskId);

  // Transition task back to ready
  await store.transition(taskId, "ready", {
    reason: "resurrected",
    agent: userName,
  });

  // Log resurrection event
  await eventLogger.log("task.resurrected", userName, {
    taskId,
    payload: {
      resurrectedBy: userName,
    },
  });
}
