/**
 * AOF query tools — read-only status and search operations.
 */

import type { TaskStatus } from "../schemas/task.js";
import { wrapResponse, compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import type { ToolContext } from "./aof-tools.js";

/**
 * Input parameters for generating a task status report.
 */
export interface AOFStatusReportInput {
  /** Identity of the requesting agent or user; defaults to "system". */
  actor?: string;
  /** Filter tasks assigned to a specific agent. */
  agent?: string;
  /** Filter tasks to a specific lifecycle status. */
  status?: TaskStatus;
  /** When true, returns a compact summary without per-task detail lines. */
  compact?: boolean;
  /** Maximum number of tasks to include in the detailed listing. */
  limit?: number;
}

/**
 * Result of a status report query, including totals, per-status breakdown,
 * and an array of task summaries.
 */
export interface AOFStatusReportResult extends ToolResponseEnvelope {
  /** Total number of tasks matching the query filters. */
  total: number;
  /** Count of tasks in each lifecycle status. */
  byStatus: Record<TaskStatus, number>;
  /** Summary array of matching tasks with ID, title, status, and assigned agent. */
  tasks: Array<{ id: string; title: string; status: TaskStatus; agent?: string }>;
}

/**
 * Generate a read-only status report of tasks in the store.
 *
 * Lists tasks filtered by optional agent and status criteria, computes
 * per-status counts, logs a knowledge.shared event, and returns either
 * a compact or detailed response envelope.
 *
 * @param ctx - Tool context providing store and logger access
 * @param input - Optional filters (agent, status, compact mode, limit)
 * @returns Status report with total count, per-status breakdown, and task summaries
 */
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
    cancelled: 0,
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
