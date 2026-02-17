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

export interface AOFDispatchInput {
  title: string;
  brief: string;
  description?: string;
  agent?: string;
  team?: string;
  role?: string;
  priority?: TaskPriority | "normal";
  dependsOn?: string[];
  parentId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  actor?: string;
}

export interface AOFDispatchResult extends ToolResponseEnvelope {
  taskId: string;
  status: TaskStatus;
  filePath: string;
}

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

export interface AOFStatusReportInput {
  actor?: string;
  agent?: string;
  status?: TaskStatus;
  compact?: boolean;
  limit?: number;
}

export interface AOFStatusReportResult extends ToolResponseEnvelope {
  total: number;
  byStatus: Record<TaskStatus, number>;
  tasks: Array<{ id: string; title: string; status: TaskStatus; agent?: string }>;
}

async function resolveTask(store: ITaskStore, taskId: string) {
  const task = await store.get(taskId);
  if (task) return task;
  const byPrefix = await store.getByPrefix(taskId);
  if (byPrefix) return byPrefix;
  throw new Error(`Task not found: ${taskId}`);
}

function normalizePriority(priority?: string): TaskPriority {
  if (!priority) return "normal";
  const normalized = priority.toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "low") {
    return normalized as TaskPriority;
  }
  return "normal";
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

export async function aofDispatch(
  ctx: ToolContext,
  input: AOFDispatchInput,
): Promise<AOFDispatchResult> {
  const actor = input.actor ?? "unknown";

  // Validate required fields
  if (!input.title || input.title.trim().length === 0) {
    throw new Error("Task title is required");
  }

  const brief = input.brief || input.description || "";
  if (!brief || brief.trim().length === 0) {
    throw new Error("Task brief/description is required");
  }

  // Normalize priority
  const priority = normalizePriority(input.priority);

  // Build metadata
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.tags) {
    metadata.tags = input.tags;
  }

  // Create task with TaskStore.create
  const task = await ctx.store.create({
    title: input.title.trim(),
    body: brief.trim(),
    priority,
    routing: {
      agent: input.agent,
      team: input.team,
      role: input.role,
    },
    dependsOn: input.dependsOn,
    parentId: input.parentId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    createdBy: actor,
  });

  // Log task.created event
  await ctx.logger.log("task.created", actor, {
    taskId: task.frontmatter.id,
    payload: {
      title: task.frontmatter.title,
      priority: task.frontmatter.priority,
      routing: task.frontmatter.routing,
    },
  });

  // Transition to ready status
  const readyTask = await ctx.store.transition(task.frontmatter.id, "ready", {
    agent: actor,
    reason: "task_dispatch",
  });

  // Log transition
  await ctx.logger.logTransition(
    task.frontmatter.id,
    "backlog",
    "ready",
    actor,
    "task_dispatch"
  );

  // Build response envelope
  const summary = `Task ${readyTask.frontmatter.id} created and ready for assignment`;
  const envelope = compactResponse(summary, {
    taskId: readyTask.frontmatter.id,
    status: readyTask.frontmatter.status,
  });

  // Ensure filePath is always defined (construct if needed)
  const filePath = readyTask.path ?? `tasks/${readyTask.frontmatter.status}/${readyTask.frontmatter.id}.md`;

  return {
    ...envelope,
    taskId: readyTask.frontmatter.id,
    status: readyTask.frontmatter.status,
    filePath,
  };
}

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

export async function aofStatusReport(
  ctx: ToolContext,
  input: AOFStatusReportInput = {},
): Promise<AOFStatusReportResult> {
  const tasks = await ctx.store.list({
    agent: input.agent,
    status: input.status,
  });

  const byStatus: Record<TaskStatus, number> = {
    backlog: 0,
    ready: 0,
    "in-progress": 0,
    blocked: 0,
    review: 0,
    done: 0,
    deadletter: 0,
  };

  for (const task of tasks) {
    byStatus[task.frontmatter.status] += 1;
  }

  const summary = tasks.map(task => ({
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    status: task.frontmatter.status,
    agent: task.frontmatter.lease?.agent ?? task.frontmatter.routing.agent,
  }));

  await ctx.logger.log("knowledge.shared", input.actor ?? "system", {
    payload: {
      type: "status_report",
      total: tasks.length,
    },
  });

  // Build compact summary
  const statusCounts = Object.entries(byStatus)
    .filter(([_, count]) => count > 0)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
  
  const taskWord = tasks.length === 1 ? "task" : "tasks";
  const summaryText = tasks.length === 0
    ? "0 tasks"
    : `${tasks.length} ${taskWord}${statusCounts ? ` (${statusCounts})` : ""}`;

  // Build detailed output
  const limitedTasks = input.limit ? summary.slice(0, input.limit) : summary;
  const detailsText = limitedTasks
    .map(t => `- ${t.id}: ${t.title} [${t.status}]${t.agent ? ` @${t.agent}` : ""}`)
    .join("\n");

  if (input.compact) {
    const envelope = compactResponse(summaryText);
    return {
      ...envelope,
      total: tasks.length,
      byStatus,
      tasks: summary,
    };
  }

  const envelope = wrapResponse(summaryText, detailsText || "(no tasks)");
  return {
    ...envelope,
    total: tasks.length,
    byStatus,
    tasks: summary,
  };
}
