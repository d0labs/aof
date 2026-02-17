/**
 * Context builder for murmur orchestration reviews.
 *
 * Assembles structured markdown context that orchestrator agents receive
 * when murmur triggers a review. Context sections are configurable per team.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrgTeam } from "../schemas/org-chart.js";
import type { MurmurState } from "./state-manager.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { Task } from "../schemas/task.js";

/** Options for context builder. */
export interface ContextBuilderOptions {
  /** Base path for doc files (vision, roadmap). Defaults to project root. */
  docsBasePath?: string;
  /** Maximum number of tasks to show in recent completions. */
  maxRecentTasks?: number;
  /** Maximum number of failed/stuck tasks to show. */
  maxFailedTasks?: number;
  /** Logger for warnings. */
  logger?: {
    warn: (message: string, meta?: unknown) => void;
  };
}

/**
 * Build review context for orchestrator agent.
 *
 * Assembles markdown document with sections based on team's murmur config.
 * Always includes taskSummary. Vision/roadmap sections are optional.
 *
 * @param team - Team definition with murmur config
 * @param state - Current murmur state for this team
 * @param store - Task store for fetching task data
 * @param options - Context builder options
 * @returns Structured markdown document for orchestrator agent
 */
export async function buildReviewContext(
  team: OrgTeam,
  state: MurmurState,
  store: ITaskStore,
  options: ContextBuilderOptions = {}
): Promise<string> {
  const {
    docsBasePath = store.projectRoot,
    maxRecentTasks = 10,
    maxFailedTasks = 10,
    logger,
  } = options;

  const sections: string[] = [];

  // Header with trigger reason
  sections.push("# Orchestration Review");
  sections.push("");
  sections.push(`**Team:** ${team.name}`);
  sections.push(`**Trigger:** ${formatTriggerReason(state)}`);
  sections.push(`**Review Started:** ${new Date().toISOString()}`);
  sections.push("");

  // Context sections based on team config
  const contextSections = team.murmur?.context ?? [];

  // Vision section (if requested)
  if (contextSections.includes("vision")) {
    const visionContent = await loadDocSection(
      "vision",
      docsBasePath,
      "docs/vision.md",
      logger
    );
    if (visionContent) {
      sections.push("## Vision");
      sections.push("");
      sections.push(visionContent);
      sections.push("");
    }
  }

  // Roadmap section (if requested)
  if (contextSections.includes("roadmap")) {
    const roadmapContent = await loadDocSection(
      "roadmap",
      docsBasePath,
      "docs/roadmap.md",
      logger
    );
    if (roadmapContent) {
      sections.push("## Roadmap");
      sections.push("");
      sections.push(roadmapContent);
      sections.push("");
    }
  }

  // Task summary section (always included)
  const taskSummary = await buildTaskSummary(
    store,
    state,
    maxRecentTasks,
    maxFailedTasks
  );
  sections.push("## Task Summary");
  sections.push("");
  sections.push(taskSummary);
  sections.push("");

  // Actionable instructions
  sections.push("## Instructions");
  sections.push("");
  sections.push(
    "Review the above. Create new tasks, adjust existing ones, or report status using the aof_task_* tools."
  );
  sections.push("");

  return sections.join("\n");
}

/**
 * Format trigger reason from murmur state.
 */
function formatTriggerReason(state: MurmurState): string {
  const trigger = state.lastTriggeredBy;
  if (!trigger) {
    return "Manual trigger";
  }

  switch (trigger) {
    case "queueEmpty":
      return "Queue empty — no ready tasks remaining";
    case "completionBatch":
      return `Completion batch threshold — ${state.completionsSinceLastReview} tasks completed`;
    case "failureBatch":
      return `Failure batch threshold — ${state.failuresSinceLastReview} tasks failed`;
    case "interval":
      return "Scheduled interval trigger";
    default:
      return trigger;
  }
}

/**
 * Load a documentation section from filesystem.
 * Returns null if file not found or unreadable.
 */
async function loadDocSection(
  sectionName: string,
  basePath: string,
  relativePath: string,
  logger?: { warn: (msg: string, meta?: unknown) => void }
): Promise<string | null> {
  const fullPath = join(basePath, relativePath);

  try {
    const content = await readFile(fullPath, "utf-8");
    return content.trim();
  } catch (error) {
    logger?.warn(`Failed to load ${sectionName} doc`, {
      path: fullPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Build task summary section with counts, recent completions, and failures.
 */
async function buildTaskSummary(
  store: ITaskStore,
  state: MurmurState,
  maxRecentTasks: number,
  maxFailedTasks: number
): Promise<string> {
  const lines: string[] = [];

  // Task counts by status
  const counts = await store.countByStatus();
  lines.push("### Current Task Counts");
  lines.push("");

  const statusOrder = [
    "backlog",
    "ready",
    "in-progress",
    "blocked",
    "review",
    "done",
    "cancelled",
    "deadletter",
  ];

  for (const status of statusOrder) {
    const count = counts[status] ?? 0;
    if (count > 0) {
      lines.push(`- **${status}**: ${count}`);
    }
  }
  lines.push("");

  // Activity since last review
  lines.push("### Activity Since Last Review");
  lines.push("");
  lines.push(`- **Completed**: ${state.completionsSinceLastReview} tasks`);
  lines.push(`- **Failed**: ${state.failuresSinceLastReview} tasks`);
  if (state.lastReviewAt) {
    lines.push(`- **Last Review**: ${state.lastReviewAt}`);
  }
  lines.push("");

  // Recent completions
  const allTasks = await store.list();
  const completedTasks = allTasks
    .filter((t) => t.frontmatter.status === "done")
    .sort(
      (a, b) =>
        new Date(b.frontmatter.updatedAt).getTime() -
        new Date(a.frontmatter.updatedAt).getTime()
    )
    .slice(0, maxRecentTasks);

  if (completedTasks.length > 0) {
    lines.push("### Recently Completed Tasks");
    lines.push("");
    for (const task of completedTasks) {
      lines.push(`- **${task.frontmatter.id}**: ${task.frontmatter.title}`);
    }
    lines.push("");
  }

  // Failed/stuck tasks (deadletter + blocked)
  const problemTasks = allTasks
    .filter(
      (t) =>
        t.frontmatter.status === "deadletter" ||
        t.frontmatter.status === "blocked"
    )
    .sort((a, b) => {
      // Sort deadletter first, then by age
      if (
        a.frontmatter.status === "deadletter" &&
        b.frontmatter.status !== "deadletter"
      ) {
        return -1;
      }
      if (
        a.frontmatter.status !== "deadletter" &&
        b.frontmatter.status === "deadletter"
      ) {
        return 1;
      }
      return (
        new Date(a.frontmatter.updatedAt).getTime() -
        new Date(b.frontmatter.updatedAt).getTime()
      );
    })
    .slice(0, maxFailedTasks);

  if (problemTasks.length > 0) {
    lines.push("### Failed/Stuck Tasks Requiring Attention");
    lines.push("");
    for (const task of problemTasks) {
      lines.push(
        `- **${task.frontmatter.id}** (${task.frontmatter.status}): ${task.frontmatter.title}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
