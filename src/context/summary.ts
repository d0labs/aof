/**
 * Sub-Agent Summary — completion reports for sub-agent tasks.
 * 
 * Summaries are concise reports (1-2K token budget) written to task outputs/
 * that capture:
 * - Overall result (success/failure/partial)
 * - Brief narrative summary (1-2 paragraphs)
 * - Deliverables produced
 * - Test results (if applicable)
 * - Warnings or issues
 * 
 * Like handoff notes, summaries are human-readable markdown designed for
 * context assembly and agent handoffs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ITaskStore } from "../store/interfaces.js";

/**
 * Sub-agent summary structure.
 */
export interface SubAgentSummary {
  taskId: string;
  agentId: string;
  completedAt: string;
  result: 'success' | 'failure' | 'partial';
  summary: string;           // 1-2 paragraphs
  deliverables: string[];    // Files produced
  testResults?: {
    total: number;
    passed: number;
    failed: number;
  };
  warnings?: string[];
}

/**
 * Generate a sub-agent summary.
 * 
 * Creates a structured summary with current timestamp.
 * Optional fields remain undefined if not provided.
 */
export function generateSummary(opts: {
  taskId: string;
  agentId: string;
  result: SubAgentSummary['result'];
  summary: string;
  deliverables: string[];
  testResults?: {
    total: number;
    passed: number;
    failed: number;
  };
  warnings?: string[];
}): SubAgentSummary {
  const summary: SubAgentSummary = {
    taskId: opts.taskId,
    agentId: opts.agentId,
    completedAt: new Date().toISOString(),
    result: opts.result,
    summary: opts.summary,
    deliverables: opts.deliverables,
  };

  if (opts.testResults) {
    summary.testResults = opts.testResults;
  }

  if (opts.warnings) {
    summary.warnings = opts.warnings;
  }

  return summary;
}

/**
 * Format a sub-agent summary as readable markdown.
 * 
 * Produces a concise, human-readable document.
 * Optional sections are omitted if data is not present.
 */
function formatSummaryMarkdown(summary: SubAgentSummary): string {
  const lines: string[] = [
    "# Sub-Agent Summary",
    "",
    "## Metadata",
    "",
    `- **Task ID**: ${summary.taskId}`,
    `- **Agent**: ${summary.agentId}`,
    `- **Completed At**: ${summary.completedAt}`,
    "",
    "## Result",
    "",
    summary.result,
    "",
    "## Summary",
    "",
    summary.summary,
    "",
    "## Deliverables",
    "",
  ];

  if (summary.deliverables.length === 0) {
    lines.push("None");
  } else {
    for (const file of summary.deliverables) {
      lines.push(`- ${file}`);
    }
  }

  // Optional: Test Results
  if (summary.testResults) {
    lines.push("", "## Test Results", "");
    const { total, passed, failed } = summary.testResults;
    lines.push(`- **Total**: ${total} tests`);
    lines.push(`- **Passed**: ${passed}`);
    lines.push(`- **Failed**: ${failed}`);
  }

  // Optional: Warnings
  if (summary.warnings && summary.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const warning of summary.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Parse markdown summary back to structured format.
 * 
 * Reads the markdown sections and reconstructs the SubAgentSummary object.
 */
function parseSummaryMarkdown(markdown: string): SubAgentSummary {
  const lines = markdown.split("\n");
  
  const summary: SubAgentSummary = {
    taskId: "",
    agentId: "",
    completedAt: "",
    result: "success",
    summary: "",
    deliverables: [],
  };

  let currentSection = "";
  let summaryLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";

    // Section headers
    if (line.startsWith("## ")) {
      const sectionName = line.slice(3).trim();
      currentSection = sectionName.toLowerCase();
      continue;
    }

    // Metadata parsing
    if (currentSection === "metadata") {
      if (line.startsWith("- **Task ID**:")) {
        summary.taskId = line.split(":")[1]?.trim() ?? "";
      } else if (line.startsWith("- **Agent**:")) {
        summary.agentId = line.split(":")[1]?.trim() ?? "";
      } else if (line.startsWith("- **Completed At**:")) {
        summary.completedAt = line.split(":").slice(1).join(":").trim();
      }
    }

    // Result parsing
    if (currentSection === "result") {
      if (line) {
        const result = line.toLowerCase() as SubAgentSummary['result'];
        if (result === "success" || result === "failure" || result === "partial") {
          summary.result = result;
        }
      }
    }

    // Summary section (multi-line text)
    if (currentSection === "summary") {
      if (line && !line.startsWith("#")) {
        summaryLines.push(line);
      }
    }

    // Deliverables
    if (currentSection === "deliverables" && line.startsWith("- ") && line !== "- None") {
      summary.deliverables.push(line.slice(2));
    }

    // Test Results
    if (currentSection === "test results") {
      if (line.startsWith("- **Total**:")) {
        if (!summary.testResults) {
          summary.testResults = { total: 0, passed: 0, failed: 0 };
        }
        const match = line.match(/(\d+)/);
        if (match) {
          summary.testResults.total = parseInt(match[1]!, 10);
        }
      } else if (line.startsWith("- **Passed**:")) {
        if (!summary.testResults) {
          summary.testResults = { total: 0, passed: 0, failed: 0 };
        }
        const match = line.match(/(\d+)/);
        if (match) {
          summary.testResults.passed = parseInt(match[1]!, 10);
        }
      } else if (line.startsWith("- **Failed**:")) {
        if (!summary.testResults) {
          summary.testResults = { total: 0, passed: 0, failed: 0 };
        }
        const match = line.match(/(\d+)/);
        if (match) {
          summary.testResults.failed = parseInt(match[1]!, 10);
        }
      }
    }

    // Warnings
    if (currentSection === "warnings" && line.startsWith("- ")) {
      if (!summary.warnings) {
        summary.warnings = [];
      }
      summary.warnings.push(line.slice(2));
    }
  }

  summary.summary = summaryLines.join("\n");

  return summary;
}

/**
 * Write a sub-agent summary to task's outputs/summary.md.
 * 
 * Formats the summary as readable markdown and writes it atomically.
 * Creates the outputs directory if it doesn't exist.
 * 
 * @throws Error if task does not exist
 */
export async function writeSummary(
  taskId: string,
  summary: SubAgentSummary,
  store: TaskStore
): Promise<void> {
  const markdown = formatSummaryMarkdown(summary);
  await store.writeTaskOutput(taskId, "summary.md", markdown);
}

/**
 * Read the sub-agent summary from task's outputs/summary.md.
 * 
 * @returns SubAgentSummary if the file exists, null otherwise
 * @throws Error if task does not exist
 */
export async function readSummary(
  taskId: string,
  store: TaskStore
): Promise<SubAgentSummary | null> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const summaryPath = join(
    store.tasksDir,
    task.frontmatter.status,
    taskId,
    "outputs",
    "summary.md"
  );

  try {
    const content = await readFile(summaryPath, "utf-8");
    return parseSummaryMarkdown(content);
  } catch (err) {
    // File doesn't exist
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
