/**
 * AOF task workflow tools — complete, dependencies, block/unblock operations.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { TaskStatus, Task } from "../schemas/task.js";
import { compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import { handleGateTransition } from "../dispatch/gate-transition-handler.js";
import type { ToolContext } from "./aof-tools.js";

async function resolveTask(store: ITaskStore, taskId: string) {
  const task = await store.get(taskId);
  if (task) return task;
  const byPrefix = await store.getByPrefix(taskId);
  if (byPrefix) return byPrefix;
  throw new Error(`Task not found: ${taskId}`);
}

/**
 * Validate gate completion parameters with teaching error messages.
 * 
 * Progressive Disclosure Level 3 — when agents make mistakes, the error teaches
 * them the correct approach.
 */
async function validateGateCompletion(
  store: ITaskStore,
  task: Task,
  input: AOFTaskCompleteInput,
): Promise<void> {
  if (!task.frontmatter.gate) {
    throw new Error(
      `Task ${task.frontmatter.id} is not in a gate workflow.\n\n` +
      `This task doesn't require outcome/blockers parameters. Use:\n` +
      `  aofTaskComplete({ taskId: "${task.frontmatter.id}", summary: "..." })`
    );
  }

  if (!input.outcome) {
    throw new Error(
      `Task ${task.frontmatter.id} is in a gate workflow (current gate: "${task.frontmatter.gate.current}").\n\n` +
      `Gate tasks REQUIRE an 'outcome' parameter. Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "complete" | "needs_review" | "blocked",\n` +
      `    summary: "..."\n` +
      `  })\n\n` +
      `Current gate: ${task.frontmatter.gate.current}`
    );
  }

  const validOutcomes: string[] = ["complete", "needs_review", "blocked"];
  if (!validOutcomes.includes(input.outcome)) {
    throw new Error(
      `Invalid outcome: "${input.outcome}".\n\n` +
      `Valid outcomes for gate workflows:\n` +
      `- "complete": Mark work done and advance to next gate\n` +
      `- "needs_review": Request changes (requires rejectionNotes)\n` +
      `- "blocked": Cannot proceed due to external dependency (requires blockers)\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "complete",\n` +
      `    summary: "..."\n` +
      `  })`
    );
  }

  // blocked → requires blockers
  if (input.outcome === "blocked" && (!input.blockers || input.blockers.length === 0)) {
    throw new Error(
      `Outcome "blocked" requires 'blockers'.\n\n` +
      `When blocking a task, list what's preventing progress.\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "blocked",\n` +
      `    blockers: ["Waiting for API key from platform team"],\n` +
      `    summary: "..."\n` +
      `  })`
    );
  }

  // needs_review → requires blockers
  if (input.outcome === "needs_review" && (!input.blockers || input.blockers.length === 0)) {
    throw new Error(
      `Outcome "needs_review" requires 'blockers' (specific issues to fix).\n\n` +
      `Specify what needs to be fixed before this can proceed.\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "needs_review",\n` +
      `    blockers: ["Missing error handling in auth flow"],\n` +
      `    summary: "Waiting on fixes"\n` +
      `  })`
    );
  }
}

// ===== TYPES =====

/**
 * Input for completing a task, supporting both legacy and gate-workflow paths.
 *
 * For gate-workflow tasks, `outcome` is required and determines the gate
 * transition (complete, needs_review, blocked). For non-gate tasks, only
 * `taskId` and optionally `summary` are needed.
 */
export interface AOFTaskCompleteInput {
  /** Full or prefix task ID to complete. */
  taskId: string;
  /** Identity of the completing agent or user; defaults to "unknown". */
  actor?: string;
  /** Completion summary appended to the task body. */
  summary?: string;
  /** Gate workflow outcome; required for tasks in a gate workflow. */
  outcome?: import("../schemas/gate.js").GateOutcome;
  /** List of blockers; required when outcome is "blocked" or "needs_review". */
  blockers?: string[];
  /** Rejection notes explaining why review was not passed. */
  rejectionNotes?: string;
  /**
   * Declared role of the calling agent (e.g., "swe-architect", "swe-qa").
   *
   * When provided, the runtime validates this against the gate's required role
   * and rejects the transition if they don't match. This is the primary
   * mechanism that prevents, for example, a backend agent from approving the
   * code-review or qa gates.
   *
   * Production callers (agents in the SDLC pipeline) MUST supply this field.
   * Omitting it allows the transition without role validation (backwards-compat
   * only — do not rely on this in new code).
   */
  callerRole?: string;
}

/**
 * Result of a task completion, including the final lifecycle status.
 */
export interface AOFTaskCompleteResult extends ToolResponseEnvelope {
  /** The resolved task ID. */
  taskId: string;
  /** The task's status after completion (typically "done" or a gate-dependent state). */
  status: TaskStatus;
}

/**
 * Input for adding a dependency (blocker) to a task.
 */
export interface AOFTaskDepAddInput {
  /** Full or prefix ID of the task that will be blocked. */
  taskId: string;
  /** Full or prefix ID of the blocking task (prerequisite). */
  blockerId: string;
  /** Identity of the agent or user adding the dependency; defaults to "unknown". */
  actor?: string;
}

/**
 * Result of adding a dependency, including the updated dependency list.
 */
export interface AOFTaskDepAddResult extends ToolResponseEnvelope {
  /** The resolved dependent task ID. */
  taskId: string;
  /** The resolved blocker task ID. */
  blockerId: string;
  /** Full list of task IDs this task now depends on. */
  dependsOn: string[];
}

/**
 * Input for removing a dependency from a task.
 */
export interface AOFTaskDepRemoveInput {
  /** Full or prefix ID of the task to remove the dependency from. */
  taskId: string;
  /** Full or prefix ID of the blocking task to remove. */
  blockerId: string;
  /** Identity of the agent or user removing the dependency; defaults to "unknown". */
  actor?: string;
}

/**
 * Result of removing a dependency, including the updated dependency list.
 */
export interface AOFTaskDepRemoveResult extends ToolResponseEnvelope {
  /** The resolved dependent task ID. */
  taskId: string;
  /** The resolved blocker task ID that was removed. */
  blockerId: string;
  /** Remaining dependency list after removal. */
  dependsOn: string[];
}

/**
 * Input for blocking a task with a reason.
 */
export interface AOFTaskBlockInput {
  /** Full or prefix task ID to block. */
  taskId: string;
  /** Human-readable explanation of what is preventing progress (required). */
  reason: string;
  /** Identity of the agent or user blocking the task; defaults to "unknown". */
  actor?: string;
}

/**
 * Result of blocking a task.
 */
export interface AOFTaskBlockResult extends ToolResponseEnvelope {
  /** The resolved task ID. */
  taskId: string;
  /** The task's status after blocking (always "blocked"). */
  status: TaskStatus;
  /** The blocking reason that was recorded. */
  reason: string;
}

/**
 * Input for unblocking a previously blocked task.
 */
export interface AOFTaskUnblockInput {
  /** Full or prefix task ID to unblock. */
  taskId: string;
  /** Identity of the agent or user unblocking; defaults to "unknown". */
  actor?: string;
}

/**
 * Result of unblocking a task.
 */
export interface AOFTaskUnblockResult extends ToolResponseEnvelope {
  /** The resolved task ID. */
  taskId: string;
  /** The task's status after unblocking (typically "ready"). */
  status: TaskStatus;
}

// ===== FUNCTIONS =====

/**
 * Complete a task through either the gate-workflow or legacy completion path.
 *
 * Gate-workflow tasks require an `outcome` parameter and are routed through
 * the gate transition handler, which validates the outcome, enforces role
 * requirements, and advances the gate state machine. Non-gate tasks follow
 * the legacy path: append an optional summary, then walk through the
 * in-progress -> review -> done lifecycle automatically.
 *
 * Throws if the task is already done (done-state lock) or if gate
 * validation fails (missing outcome, invalid outcome, missing blockers).
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task ID, optional summary, and gate-workflow fields
 * @returns The completed task's ID and final status
 */
export async function aofTaskComplete(
  ctx: ToolContext,
  input: AOFTaskCompleteInput,
): Promise<AOFTaskCompleteResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);
  let updatedTask = task;

  // AC-3: Done-state lock — tasks already marked done cannot be re-completed.
  // Resurrection goes through a dedicated admin pathway, not task completion.
  if (task.frontmatter.status === "done") {
    throw new Error(
      `Task ${task.frontmatter.id} is already done and cannot be re-transitioned. ` +
      `If you need to re-open this task, contact an administrator.`
    );
  }

  // AC-2: Gate workflow tasks MUST use the gate path — no legacy bypass allowed.
  // Previously, a gate task called without `outcome` would fall through to the
  // legacy completion path and mark the task `done` without any gate validation.
  // Now we gate the legacy path behind `!task.frontmatter.gate`.
  if (task.frontmatter.gate) {
    // Gate task: always validate and use gate transition handler
    await validateGateCompletion(ctx.store, task, input);

    await handleGateTransition(
      ctx.store,
      ctx.logger,
      input.taskId,
      input.outcome!,  // validated above — will be defined
      {
        summary: input.summary ?? "Completed",
        blockers: input.blockers,
        rejectionNotes: input.rejectionNotes,
        agent: actor,
        callerRole: input.callerRole,
      }
    );

    // Reload task to get updated state
    const reloadedTask = await ctx.store.get(input.taskId);
    if (!reloadedTask) {
      throw new Error(`Task ${input.taskId} not found after gate transition`);
    }

    const summary = `Task ${input.taskId} transitioned through gate workflow`;
    const envelope = compactResponse(summary, {
      taskId: input.taskId,
      status: reloadedTask.frontmatter.status,
    });

    return {
      ...envelope,
      taskId: input.taskId,
      status: reloadedTask.frontmatter.status,
    };
  }

  // Legacy completion path (non-gate tasks only)
  if (input.summary) {
    const body = task.body ? `${task.body}\n\n## Completion Summary\n${input.summary}` : `## Completion Summary\n${input.summary}`;
    updatedTask = await ctx.store.updateBody(task.frontmatter.id, body);
  }

  if (updatedTask.frontmatter.status !== "done") {
    const from = updatedTask.frontmatter.status;
    
    // BUG-008: Enforce lifecycle consistency - tasks must pass through in-progress and review before done
    // Valid path: any → ready → in-progress → review → done
    
    // Step 1: Get to in-progress
    if (from !== "in-progress" && from !== "review") {
      // Special case: blocked can only go to ready first
      if (from === "blocked") {
        // blocked → ready
        updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "ready", {
          reason: "manual_completion_unblock",
          agent: actor,
        });
        await ctx.logger.logTransition(updatedTask.frontmatter.id, from, "ready", actor, 
          "Manual completion: unblocking task");
      }
      
      // Now transition to in-progress (from ready or backlog)
      const currentStatus = updatedTask.frontmatter.status;
      updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "in-progress", {
        reason: "manual_completion_lifecycle_guard",
        agent: actor,
      });
      await ctx.logger.logTransition(updatedTask.frontmatter.id, currentStatus, "in-progress", actor, 
        "Manual completion: enforcing lifecycle consistency");
    }
    
    // Step 2: Transition to review (if not already there)
    if (updatedTask.frontmatter.status === "in-progress") {
      updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "review", {
        reason: "manual_completion_review",
        agent: actor,
      });
      await ctx.logger.logTransition(updatedTask.frontmatter.id, "in-progress", "review", actor, 
        "Manual completion: moving to review");
    }
    
    // Step 3: Transition to done
    updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, "done", {
      reason: "task_complete",
      agent: actor,
    });
    await ctx.logger.logTransition(updatedTask.frontmatter.id, "review", "done", actor, "task_complete");
  }

  await ctx.logger.log("task.completed", actor, { taskId: updatedTask.frontmatter.id });

  const summary = `Task ${updatedTask.frontmatter.id} completed successfully`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
  };
}

/**
 * Add a dependency (blocker) to a task.
 *
 * Both the dependent task and the blocker task are resolved by full ID or
 * prefix. The blocker is added to the dependent task's `dependsOn` array,
 * preventing it from being dispatched until the blocker completes.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Dependent task ID and blocker task ID
 * @returns The dependent task's updated dependency list
 */
export async function aofTaskDepAdd(
  ctx: ToolContext,
  input: AOFTaskDepAddInput,
): Promise<AOFTaskDepAddResult> {
  const actor = input.actor ?? "unknown";
  
  // Validate both tasks exist
  const task = await resolveTask(ctx.store, input.taskId);
  const blocker = await resolveTask(ctx.store, input.blockerId);

  const updatedTask = await ctx.store.addDep(task.frontmatter.id, blocker.frontmatter.id);

  await ctx.logger.log("task.dep.added", actor, {
    taskId: updatedTask.frontmatter.id,
    payload: { blockerId: blocker.frontmatter.id },
  });

  const summary = `Task ${updatedTask.frontmatter.id} now depends on ${blocker.frontmatter.id}`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
    dependsOn: updatedTask.frontmatter.dependsOn ?? [],
  };
}

/**
 * Remove a dependency (blocker) from a task.
 *
 * Both the dependent task and the blocker task are resolved by full ID or
 * prefix. The blocker is removed from the dependent task's `dependsOn` array.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Dependent task ID and blocker task ID to remove
 * @returns The dependent task's updated dependency list after removal
 */
export async function aofTaskDepRemove(
  ctx: ToolContext,
  input: AOFTaskDepRemoveInput,
): Promise<AOFTaskDepRemoveResult> {
  const actor = input.actor ?? "unknown";
  
  // Validate both tasks exist
  const task = await resolveTask(ctx.store, input.taskId);
  const blocker = await resolveTask(ctx.store, input.blockerId);

  const updatedTask = await ctx.store.removeDep(task.frontmatter.id, blocker.frontmatter.id);

  await ctx.logger.log("task.dep.removed", actor, {
    taskId: updatedTask.frontmatter.id,
    payload: { blockerId: blocker.frontmatter.id },
  });

  const summary = `Task ${updatedTask.frontmatter.id} no longer depends on ${blocker.frontmatter.id}`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    blockerId: blocker.frontmatter.id,
    dependsOn: updatedTask.frontmatter.dependsOn ?? [],
  };
}

/**
 * Block a task, transitioning it to "blocked" status with a required reason.
 *
 * The reason must be a non-empty string explaining what prevents progress.
 * A task.blocked event is logged. Blocked tasks are excluded from dispatch
 * until explicitly unblocked.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task ID and blocking reason (required)
 * @returns The blocked task's ID, status, and recorded reason
 */
export async function aofTaskBlock(
  ctx: ToolContext,
  input: AOFTaskBlockInput,
): Promise<AOFTaskBlockResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error("Block reason is required. Provide a clear explanation of what's blocking progress.");
  }

  const blockedTask = await ctx.store.block(task.frontmatter.id, input.reason);

  await ctx.logger.log("task.blocked", actor, {
    taskId: blockedTask.frontmatter.id,
    payload: { reason: input.reason },
  });

  const summary = `Task ${blockedTask.frontmatter.id} blocked: ${input.reason}`;
  const envelope = compactResponse(summary, {
    taskId: blockedTask.frontmatter.id,
    status: blockedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: blockedTask.frontmatter.id,
    status: blockedTask.frontmatter.status,
    reason: input.reason,
  };
}

/**
 * Unblock a previously blocked task, moving it back to "ready" status.
 *
 * Delegates to store.unblock() which transitions the task from "blocked"
 * to "ready" and logs a task.unblocked event. The task becomes eligible
 * for dispatch again.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Task ID to unblock
 * @returns The unblocked task's ID and new status
 */
export async function aofTaskUnblock(
  ctx: ToolContext,
  input: AOFTaskUnblockInput,
): Promise<AOFTaskUnblockResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  const unblockedTask = await ctx.store.unblock(task.frontmatter.id);

  await ctx.logger.log("task.unblocked", actor, {
    taskId: unblockedTask.frontmatter.id,
  });

  const summary = `Task ${unblockedTask.frontmatter.id} unblocked and moved to ready`;
  const envelope = compactResponse(summary, {
    taskId: unblockedTask.frontmatter.id,
    status: unblockedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: unblockedTask.frontmatter.id,
    status: unblockedTask.frontmatter.status,
  };
}
