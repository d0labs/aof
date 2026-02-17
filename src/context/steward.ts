/**
 * Context steward — footprint tracking, transparency, and threshold alerts.
 *
 * Scans task artifacts to calculate per-agent context footprints and detects
 * when agents exceed their context budget policies.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ITaskStore } from "../store/interfaces.js";
import type { OrgChart } from "../schemas/org-chart.js";
import type { ContextBudgetPolicy } from "./budget.js";
import { estimateTokens } from "./budget.js";

/** Per-agent context footprint. */
export interface AgentFootprint {
  agentId: string;
  totalChars: number;
  estimatedTokens: number;
  breakdown: {
    path: string;
    chars: number;
    kind: "task" | "input" | "output" | "skill" | "other";
  }[];
}

/** Footprint alert when threshold exceeded. */
export interface FootprintAlert {
  agentId: string;
  level: "warn" | "critical";
  currentChars: number;
  threshold: number;
  message: string;
}

/** Transparency report with footprints and alerts. */
export interface TransparencyReport {
  timestamp: string;
  agents: AgentFootprint[];
  topContributors: {
    path: string;
    chars: number;
    percentage: number;
  }[];
  alerts: FootprintAlert[];
}

/**
 * Calculate footprint for a specific agent by scanning their task artifacts.
 */
export async function calculateFootprint(
  agentId: string,
  store: ITaskStore,
  opts?: { includeOutputs?: boolean }
): Promise<AgentFootprint> {
  const tasks = await store.list();
  const agentTasks = tasks.filter((t) => t.frontmatter.createdBy === agentId);

  const breakdown: AgentFootprint["breakdown"] = [];
  let totalChars = 0;

  for (const task of agentTasks) {
    // Count the task file itself (body + serialized frontmatter)
    if (task.path) {
      try {
        const content = await readFile(task.path, "utf-8");
        const chars = content.length;
        breakdown.push({
          path: task.path,
          chars,
          kind: "task",
        });
        totalChars += chars;
      } catch {
        // Task file doesn't exist or unreadable — skip
      }
    }

    // Count input files
    const taskId = task.frontmatter.id;
    try {
      const inputs = await store.getTaskInputs(taskId);
      for (const inputFile of inputs) {
        const inputPath = join(
          store.tasksDir,
          task.frontmatter.status,
          taskId,
          "inputs",
          inputFile
        );
        try {
          const content = await readFile(inputPath, "utf-8");
          const chars = content.length;
          breakdown.push({
            path: inputPath,
            chars,
            kind: "input",
          });
          totalChars += chars;
        } catch {
          // File unreadable (binary?) — skip
        }
      }
    } catch {
      // No inputs directory — skip
    }

    // Count output files if requested
    if (opts?.includeOutputs) {
      try {
        const outputs = await store.getTaskOutputs(taskId);
        for (const outputFile of outputs) {
          const outputPath = join(
            store.tasksDir,
            task.frontmatter.status,
            taskId,
            "outputs",
            outputFile
          );
          try {
            const content = await readFile(outputPath, "utf-8");
            const chars = content.length;
            breakdown.push({
              path: outputPath,
              chars,
              kind: "output",
            });
            totalChars += chars;
          } catch {
            // File unreadable (binary?) — skip
          }
        }
      } catch {
        // No outputs directory — skip
      }
    }
  }

  return {
    agentId,
    totalChars,
    estimatedTokens: totalChars === 0 ? 0 : Math.ceil(totalChars / 4),
    breakdown,
  };
}

/**
 * Calculate footprints for all agents.
 * If orgChart is provided, includes agents with zero footprint.
 */
export async function calculateAllFootprints(
  store: ITaskStore,
  orgChart?: OrgChart
): Promise<AgentFootprint[]> {
  // Get unique agent IDs from tasks
  const tasks = await store.list();
  const agentIds = new Set<string>();
  for (const task of tasks) {
    agentIds.add(task.frontmatter.createdBy);
  }

  // Add agents from org chart (with zero footprint if no tasks)
  if (orgChart) {
    for (const agent of orgChart.agents) {
      agentIds.add(agent.id);
    }
  }

  // Calculate footprints for each agent
  const footprints: AgentFootprint[] = [];
  for (const agentId of agentIds) {
    const footprint = await calculateFootprint(agentId, store);
    footprints.push(footprint);
  }

  return footprints;
}

/**
 * Generate transparency report with top contributors and alerts.
 */
export function generateTransparencyReport(
  footprints: AgentFootprint[],
  policies?: Map<string, ContextBudgetPolicy>
): TransparencyReport {
  // Calculate total chars across all agents
  const totalChars = footprints.reduce((sum, f) => sum + f.totalChars, 0);

  // Aggregate all breakdown entries and sort by chars (descending)
  const allBreakdown = footprints.flatMap((f) => f.breakdown);
  const sorted = allBreakdown.sort((a, b) => b.chars - a.chars);

  // Top 10 contributors with percentages
  const topContributors = sorted.slice(0, 10).map((entry) => ({
    path: entry.path,
    chars: entry.chars,
    percentage: totalChars > 0 ? (entry.chars / totalChars) * 100 : 0,
  }));

  // Generate alerts if policies provided
  const alerts = policies ? checkThresholds(footprints, policies) : [];

  return {
    timestamp: new Date().toISOString(),
    agents: footprints,
    topContributors,
    alerts,
  };
}

/**
 * Check footprints against policies and return alerts.
 */
export function checkThresholds(
  footprints: AgentFootprint[],
  policies: Map<string, ContextBudgetPolicy>
): FootprintAlert[] {
  const alerts: FootprintAlert[] = [];

  for (const footprint of footprints) {
    const policy = policies.get(footprint.agentId);
    if (!policy) continue;

    // Check critical threshold (highest priority)
    if (footprint.totalChars > policy.critical) {
      alerts.push({
        agentId: footprint.agentId,
        level: "critical",
        currentChars: footprint.totalChars,
        threshold: policy.critical,
        message: `Agent ${footprint.agentId} context (${footprint.totalChars} chars) exceeds critical threshold (${policy.critical} chars)`,
      });
    }
    // Check warn threshold
    else if (footprint.totalChars > policy.warn) {
      alerts.push({
        agentId: footprint.agentId,
        level: "warn",
        currentChars: footprint.totalChars,
        threshold: policy.warn,
        message: `Agent ${footprint.agentId} context (${footprint.totalChars} chars) exceeds warn threshold (${policy.warn} chars)`,
      });
    }
  }

  return alerts;
}
