/**
 * AOF query tools — read-only status and search operations.
 */

import type { TaskStatus } from "../schemas/task.js";
import { wrapResponse, compactResponse, type ToolResponseEnvelope } from "./envelope.js";
import type { ToolContext } from "./aof-tools.js";

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
