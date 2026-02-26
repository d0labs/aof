/**
 * aof_dispatch — high-level dispatch with context bundling.
 * 
 * Wraps GatewayAdapter with context assembly and status management.
 * This is the recommended entry point for dispatching tasks with full context.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { GatewayAdapter } from "./executor.js";
import { assembleContext, type ContextBundle, type AssembleOptions } from "../context/assembler.js";

export interface AofDispatchOptions {
  taskId: string;
  agentId?: string;              // Override agent; otherwise from task routing
  store: ITaskStore;
  executor: GatewayAdapter;
  contextOpts?: AssembleOptions; // maxChars, etc.
}

export interface DispatchResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  context?: ContextBundle;       // Assembled context bundle
  taskStatus?: string;           // Task status after dispatch
}

/**
 * Dispatch a task with full context assembly.
 * 
 * Flow:
 * 1. Get task and determine agent
 * 2. Assemble context bundle (task card + inputs/)
 * 3. Transition task to in-progress
 * 4. Spawn agent session via executor
 * 5. Return dispatch result with context stats
 * 
 * @param opts - Dispatch options
 * @returns Dispatch result with session info and context stats
 */
export async function aofDispatch(opts: AofDispatchOptions): Promise<DispatchResult> {
  const { taskId, agentId, store, executor, contextOpts } = opts;

  // Step 1: Get task and determine agent
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const targetAgent = agentId ?? task.frontmatter.routing.agent;
  if (!targetAgent) {
    throw new Error(`No agent specified for task ${taskId} (provide agentId or set routing.agent in task card)`);
  }

  // Step 2: Assemble context bundle
  const contextBundle = await assembleContext(taskId, store, contextOpts);

  // Step 3: Transition task to in-progress
  // This must happen before spawn to ensure task state is consistent
  const currentStatus = task.frontmatter.status;
  if (currentStatus !== "in-progress") {
    await store.transition(taskId, "in-progress");
  }

  // Step 4: Spawn agent session
  const taskPath = task.path ?? `tasks/${task.frontmatter.status}/${taskId}.md`;
  
  const executorResult = await executor.spawnSession({
    taskId,
    taskPath,
    agent: targetAgent,
    priority: task.frontmatter.priority,
    routing: task.frontmatter.routing,
  });

  // Step 5: Build result
  const result: DispatchResult = {
    success: executorResult.success,
    sessionId: executorResult.sessionId,
    error: executorResult.error,
    context: contextBundle,
    taskStatus: "in-progress",
  };

  return result;
}
