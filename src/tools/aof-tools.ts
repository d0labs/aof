import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import type { TaskStatus, TaskPriority } from "../schemas/task.js";
import { wrapResponse, compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import { handleGateTransition } from "../dispatch/gate-transition-handler.js";

export interface ToolContext {
  store: ITaskStore;
  logger: EventLogger;
}

// Re-exported from project-tools.ts
export type { AOFDispatchInput, AOFDispatchResult } from "./project-tools.js";

export interface AOFTaskUpdateInput {
  taskId: string;
  body?: string;
  status?: TaskStatus;
  actor?: string;
  reason?: string;
}

export interface AOFTaskUpdateResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  updatedAt: string;
  bodyUpdated: boolean;
  transitioned: boolean;
}

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

// Re-exported from query-tools.ts
export type { AOFStatusReportInput, AOFStatusReportResult } from "./query-tools.js";

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
 * 
 * @param store - Task store instance
 * @param task - Task being completed
 * @param input - Completion input parameters
 * @throws Error with actionable teaching message if validation fails
 */
async function validateGateCompletion(
  store: ITaskStore,
  task: import("../schemas/task.js").Task,
  input: AOFTaskCompleteInput
): Promise<void> {
  const outcome = input.outcome;
  
  // Scenario 1: Invalid outcome value
  const validOutcomes = ["complete", "needs_review", "blocked"];
  if (outcome && !validOutcomes.includes(outcome)) {
    throw new Error(
      `Invalid gate outcome. Expected one of: complete, needs_review, blocked. ` +
      `You sent '${outcome}'. Use 'complete' to advance to the next gate, ` +
      `'needs_review' to send work back for revision, or 'blocked' when external ` +
      `dependencies prevent progress.`
    );
  }
  
  // Load project manifest to check gate configuration
  if (outcome && (outcome === "needs_review" || outcome === "blocked")) {
    const { loadProjectManifest } = await import("../dispatch/gate-transition-handler.js");
    const projectManifest = await loadProjectManifest(store.projectRoot);
    
    if (!projectManifest.workflow) {
      // No workflow - graceful fallback, no validation needed
      return;
    }
    
    const currentGate = task.frontmatter.gate?.current;
    const gateConfig = projectManifest.workflow.gates.find(g => g.id === currentGate);
    
    if (!gateConfig) {
      throw new Error(`Current gate ${currentGate} not found in workflow`);
    }
    
    // Scenario 2: Rejection at non-rejectable gate
    if (outcome === "needs_review" && !gateConfig.canReject) {
      throw new Error(
        `This gate (${currentGate}) does not allow rejection. ` +
        `Use 'complete' to advance to the next gate, or 'blocked' if you're waiting ` +
        `on external dependencies. If work truly needs to be redone, coordinate with ` +
        `the workflow owner to enable rejection for this gate.`
      );
    }
    
    // Scenario 3: needs_review without rejectionNotes
    if (outcome === "needs_review") {
      if (!input.rejectionNotes || input.rejectionNotes.trim().length === 0) {
        throw new Error(
          `When rejecting work (needs_review), you must provide rejectionNotes ` +
          `explaining what needs to change. Be specific: what's wrong, why it needs ` +
          `to change, and what success looks like. Example: "Missing error handling ` +
          `for expired tokens. Add try-catch blocks and retry logic."`
        );
      }
    }
    
    // Scenario 4: blocked without blockers
    if (outcome === "blocked") {
      if (!input.blockers || input.blockers.length === 0) {
        throw new Error(
          `When marking blocked, provide a blockers array listing what's preventing ` +
          `progress. Be specific so others can help unblock you. Example: ` +
          `["Waiting for API spec from platform team", "Need production database access"]`
        );
      }
    }
  }
}

// Re-exported from project-tools.ts
export { aofDispatch } from "./project-tools.js";

export async function aofTaskUpdate(
  ctx: ToolContext,
  input: AOFTaskUpdateInput,
): Promise<AOFTaskUpdateResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  let updatedTask = task;
  if (input.body !== undefined) {
    updatedTask = await ctx.store.updateBody(task.frontmatter.id, input.body);
  }

  let transitioned = false;
  if (input.status && input.status !== updatedTask.frontmatter.status) {
    const from = updatedTask.frontmatter.status;
    updatedTask = await ctx.store.transition(updatedTask.frontmatter.id, input.status, {
      reason: input.reason,
      agent: actor,
    });
    await ctx.logger.logTransition(updatedTask.frontmatter.id, from, input.status, actor, input.reason);
    transitioned = true;
  }

  const actions = [];
  if (input.body !== undefined) actions.push("body updated");
  if (transitioned) actions.push(`→ ${updatedTask.frontmatter.status}`);
  const summary = `Task ${updatedTask.frontmatter.id} ${actions.join(", ")}`;

  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    status: updatedTask.frontmatter.status,
    updatedAt: updatedTask.frontmatter.updatedAt,
    bodyUpdated: input.body !== undefined,
    transitioned,
  };
}

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

// Re-exported from query-tools.ts
export { aofStatusReport } from "./query-tools.js";

// ===== NEW TASK MANAGEMENT TOOLS =====

export interface AOFTaskEditInput {
  taskId: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  routing?: {
    role?: string;
    team?: string;
    agent?: string;
    tags?: string[];
  };
  actor?: string;
}

export interface AOFTaskEditResult extends ToolResponseEnvelope {
  taskId: string;
  updatedFields: string[];
  task: {
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
  };
}

export async function aofTaskEdit(
  ctx: ToolContext,
  input: AOFTaskEditInput,
): Promise<AOFTaskEditResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  // Build patch object
  const patch: {
    title?: string;
    description?: string;
    priority?: string;
    routing?: {
      role?: string;
      team?: string;
      agent?: string;
      tags?: string[];
    };
  } = {};

  const updatedFields: string[] = [];

  if (input.title !== undefined) {
    patch.title = input.title;
    updatedFields.push("title");
  }

  if (input.description !== undefined) {
    patch.description = input.description;
    updatedFields.push("description");
  }

  if (input.priority !== undefined) {
    patch.priority = input.priority;
    updatedFields.push("priority");
  }

  if (input.routing !== undefined) {
    patch.routing = input.routing;
    updatedFields.push("routing");
  }

  if (updatedFields.length === 0) {
    throw new Error("No fields to update. Provide at least one of: title, description, priority, routing");
  }

  const updatedTask = await ctx.store.update(task.frontmatter.id, patch);

  const summary = `Task ${updatedTask.frontmatter.id} updated: ${updatedFields.join(", ")}`;
  const envelope = compactResponse(summary, {
    taskId: updatedTask.frontmatter.id,
    updatedFields,
  });

  return {
    ...envelope,
    taskId: updatedTask.frontmatter.id,
    updatedFields,
    task: {
      title: updatedTask.frontmatter.title,
      status: updatedTask.frontmatter.status,
      priority: updatedTask.frontmatter.priority,
    },
  };
}

export interface AOFTaskCancelInput {
  taskId: string;
  reason?: string;
  actor?: string;
}

export interface AOFTaskCancelResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  reason?: string;
}

export async function aofTaskCancel(
  ctx: ToolContext,
  input: AOFTaskCancelInput,
): Promise<AOFTaskCancelResult> {
  const actor = input.actor ?? "unknown";
  const task = await resolveTask(ctx.store, input.taskId);

  const cancelledTask = await ctx.store.cancel(task.frontmatter.id, input.reason);

  await ctx.logger.log("task.cancelled", actor, {
    taskId: cancelledTask.frontmatter.id,
    payload: { reason: input.reason },
  });

  const summary = input.reason
    ? `Task ${cancelledTask.frontmatter.id} cancelled: ${input.reason}`
    : `Task ${cancelledTask.frontmatter.id} cancelled`;

  const envelope = compactResponse(summary, {
    taskId: cancelledTask.frontmatter.id,
    status: cancelledTask.frontmatter.status,
  });

  return {
    ...envelope,
    taskId: cancelledTask.frontmatter.id,
    status: cancelledTask.frontmatter.status,
    reason: input.reason,
  };
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

export interface AOFTaskUnblockInput {
  taskId: string;
  actor?: string;
}

export interface AOFTaskUnblockResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
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
