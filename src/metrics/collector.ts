/**
 * Metrics collector — gathers MetricsState from the task store.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { MetricsState } from "./exporter.js";

/**
 * Collect current metrics state from the task store.
 */
export async function collectMetrics(store: ITaskStore): Promise<MetricsState> {
  const allTasks = await store.list();

  // Task counts by status
  const tasksByStatus: Record<string, number> = {};
  const agentStatusMap = new Map<string, Map<string, number>>();

  for (const task of allTasks) {
    const status = task.frontmatter.status;
    tasksByStatus[status] = (tasksByStatus[status] ?? 0) + 1;

    const agent = task.frontmatter.lease?.agent ?? task.frontmatter.routing.agent;
    if (agent) {
      if (!agentStatusMap.has(agent)) {
        agentStatusMap.set(agent, new Map());
      }
      const m = agentStatusMap.get(agent)!;
      m.set(status, (m.get(status) ?? 0) + 1);
    }
  }

  const tasksByAgentAndStatus: Array<{ agent: string; status: string; count: number }> = [];
  for (const [agent, statusMap] of agentStatusMap) {
    for (const [status, count] of statusMap) {
      tasksByAgentAndStatus.push({ agent, status, count });
    }
  }

  // Stale tasks
  const staleTasks: Array<{ agent: string; taskId: string; stalenessSeconds: number }> = [];
  const now = Date.now();
  for (const task of allTasks) {
    if (task.frontmatter.lease && task.frontmatter.status === "in-progress") {
      const acquiredAt = new Date(task.frontmatter.lease.acquiredAt).getTime();
      const stalenessSeconds = Math.round((now - acquiredAt) / 1000);
      staleTasks.push({
        agent: task.frontmatter.lease.agent,
        taskId: task.frontmatter.id,
        stalenessSeconds,
      });
    }
  }

  return {
    tasksByStatus,
    tasksByAgentAndStatus,
    staleTasks,
    schedulerUp: true,
  };
}
