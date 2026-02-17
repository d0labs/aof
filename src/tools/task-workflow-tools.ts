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
      `Task ${task.frontmatter.id} is in gate workflow "${task.frontmatter.gate.workflowId}".\n\n` +
      `Gate tasks REQUIRE an 'outcome' parameter. Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "approved" | "needs_review" | "rejected",\n` +
      `    summary: "..."\n` +
      `  })\n\n` +
      `Workflow: ${task.frontmatter.gate.workflowId} | Current: ${task.frontmatter.gate.currentGate}`
    );
  }

  const validOutcomes = ["approved", "needs_review", "rejected"] as const;
  if (!validOutcomes.includes(input.outcome)) {
    throw new Error(
      `Invalid outcome: "${input.outcome}".\n\n` +
      `Valid outcomes for gate workflows:\n` +
      `- "approved": Mark complete and advance to next gate\n` +
      `- "needs_review": Request review from another agent/team\n` +
      `- "rejected": Block progression (requires rejection notes)\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "approved",\n` +
      `    summary: "..."\n` +
      `  })`
    );
  }

  // rejection → requires rejectionNotes
  if (input.outcome === "rejected" && !input.rejectionNotes) {
    throw new Error(
      `Outcome "rejected" requires 'rejectionNotes'.\n\n` +
      `When rejecting a task, explain WHY so the team can fix it.\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "rejected",\n` +
      `    rejectionNotes: "Missing error handling in auth flow",\n` +
      `    summary: "..."\n` +
      `  })`
    );
  }

  // needs_review → requires blockers
  if (input.outcome === "needs_review" && (!input.blockers || input.blockers.length === 0)) {
    throw new Error(
      `Outcome "needs_review" requires 'blockers' (task IDs to review).\n\n` +
      `Specify which tasks need review before this can proceed.\n\n` +
      `Use:\n` +
      `  aofTaskComplete({\n` +
      `    taskId: "${task.frontmatter.id}",\n` +
      `    outcome: "needs_review",\n` +
      `    blockers: ["TASK-2026-02-15-001"],\n` +
      `    summary: "Waiting on security review"\n` +
      `  })`
    );
  }
}

// ===== TYPES =====

export interface AOFTaskCompleteInput {
  taskId: string;
  actor?: string;
  summary?: string;
  // Gate workflow fields (optional — only used when task is in a workflow)
  outcome?: import("../schemas/gate.js").GateOutcome;
  blockers?: string[];
  rejectionNotes?: string;
}

export interface AOFTaskCompleteResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
}

export interface AOFTaskDepAddInput {
  taskId: string;
  blockerId: string;
  actor?: string;
}

export interface AOFTaskDepAddResult extends ToolResponseEnvelope {
  taskId: string;
  blockerId: string;
  dependsOn: string[];
}

export interface AOFTaskDepRemoveInput {
  taskId: string;
  blockerId: string;
  actor?: string;
}

export interface AOFTaskDepRemoveResult extends ToolResponseEnvelope {
  taskId: string;
  blockerId: string;
  dependsOn: string[];
}

export interface AOFTaskBlockInput {
  taskId: string;
  reason: string;
  actor?: string;
}

export interface AOFTaskBlockResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  reason: string;
}

export interface AOFTaskUnblockInput {
  taskId: string;
  actor?: string;
}

export interface AOFTaskUnblockResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
}

// ===== FUNCTIONS =====

export async function aofTaskComplete(
  ctx: ToolContext,
  input: AOFTaskCompleteInput,
): Promise<AOFTaskCompleteResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);
  let updatedTask = task;

  // If task is in a gate workflow AND outcome provided, use gate transition handler
  // Backward compatible: tasks not in gate workflows use legacy path below
  if (task.frontmatter.gate && input.outcome) {
    // Validate gate completion parameters before processing
    await validateGateCompletion(ctx.store, task, input);
    
    await handleGateTransition(
      ctx.store,
      ctx.logger,
      input.taskId,
      input.outcome,
      {
        summary: input.summary ?? "Completed",
        blockers: input.blockers,
        rejectionNotes: input.rejectionNotes,
        agent: actor,
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

  // Legacy completion path (no workflow)
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

export async function aofTaskDepAdd(
  ctx: ToolContext,
  input: AOFTaskDepAddInput,
): Promise<AOFTaskDepAddResult> {
  const actor = input.actor ?? "unknown";
  
  // Validate both tasks exist
  const task = await resolveTask(ctx.store, input.taskId);
  const blocker = await resolveTask(ctx.store, input.blockerId);

  const updatedTask = await ctx.store.addDep(task.frontmatter.id, blocker.frontmatter.id);

  await ctx.logger.log("task.dependency.added", actor, {
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

export async function aofTaskDepRemove(
  ctx: ToolContext,
  input: AOFTaskDepRemoveInput,
): Promise<AOFTaskDepRemoveResult> {
  const actor = input.actor ?? "unknown";
  
  // Validate both tasks exist
  const task = await resolveTask(ctx.store, input.taskId);
  const blocker = await resolveTask(ctx.store, input.blockerId);

  const updatedTask = await ctx.store.removeDep(task.frontmatter.id, blocker.frontmatter.id);

  await ctx.logger.log("task.dependency.removed", actor, {
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
