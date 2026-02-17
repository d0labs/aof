/**
 * Handoff Notes — preserve context across compaction and sub-agent boundaries.
 * 
 * Handoff notes are structured documents written to task outputs/ that capture:
 * - Current progress and status
 * - Blockers and next steps
 * - Key decisions and artifacts
 * - Dependencies
 * 
 * These notes are human-readable markdown (not raw JSON) designed to be
 * included in context assembly for resuming work after compaction or
 * agent handoffs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ITaskStore } from "../store/interfaces.js";

/**
 * Handoff note structure.
 */
export interface HandoffNote {
  taskId: string;
  timestamp: string;       // ISO 8601
  trigger: 'compaction' | 'sub-agent-complete' | 'manual';
  status: {
    current: string;       // Task status
    progress: string;      // What's been done
    blockers: string[];    // Current blockers
    nextSteps: string[];   // What needs to happen next
  };
  context: {
    keyDecisions: string[];  // Important decisions made
    artifacts: string[];     // Files created/modified
    dependencies: string[];  // What this task depends on
  };
}

/**
 * Generate a handoff note for a task.
 * 
 * Creates a structured handoff note with current timestamp.
 * Optional fields default to empty arrays or strings.
 */
export function generateHandoff(opts: {
  taskId: string;
  trigger: HandoffNote['trigger'];
  progress: string;
  current?: string;
  blockers?: string[];
  nextSteps?: string[];
  keyDecisions?: string[];
  artifacts?: string[];
  dependencies?: string[];
}): HandoffNote {
  return {
    taskId: opts.taskId,
    timestamp: new Date().toISOString(),
    trigger: opts.trigger,
    status: {
      current: opts.current ?? "",
      progress: opts.progress,
      blockers: opts.blockers ?? [],
      nextSteps: opts.nextSteps ?? [],
    },
    context: {
      keyDecisions: opts.keyDecisions ?? [],
      artifacts: opts.artifacts ?? [],
      dependencies: opts.dependencies ?? [],
    },
  };
}

/**
 * Format a handoff note as readable markdown.
 * 
 * Produces a human-readable document with clear section headers.
 * Empty arrays are shown as "None" rather than omitted.
 */
function formatHandoffMarkdown(note: HandoffNote): string {
  const lines: string[] = [
    "# Handoff Note",
    "",
    "## Metadata",
    "",
    `- **Task ID**: ${note.taskId}`,
    `- **Timestamp**: ${note.timestamp}`,
    `- **Trigger**: ${note.trigger}`,
    `- **Status**: ${note.status.current || "(not specified)"}`,
    "",
    "## Progress",
    "",
    note.status.progress,
    "",
    "## Blockers",
    "",
  ];

  if (note.status.blockers.length === 0) {
    lines.push("None");
  } else {
    for (const blocker of note.status.blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  lines.push("", "## Next Steps", "");

  if (note.status.nextSteps.length === 0) {
    lines.push("None");
  } else {
    for (const step of note.status.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push("", "## Key Decisions", "");

  if (note.context.keyDecisions.length === 0) {
    lines.push("None");
  } else {
    for (const decision of note.context.keyDecisions) {
      lines.push(`- ${decision}`);
    }
  }

  lines.push("", "## Artifacts", "");

  if (note.context.artifacts.length === 0) {
    lines.push("None");
  } else {
    for (const artifact of note.context.artifacts) {
      lines.push(`- ${artifact}`);
    }
  }

  lines.push("", "## Dependencies", "");

  if (note.context.dependencies.length === 0) {
    lines.push("None");
  } else {
    for (const dep of note.context.dependencies) {
      lines.push(`- ${dep}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Parse markdown handoff note back to structured format.
 * 
 * Reads the markdown sections and reconstructs the HandoffNote object.
 */
function parseHandoffMarkdown(markdown: string): HandoffNote {
  const lines = markdown.split("\n");
  
  const note: HandoffNote = {
    taskId: "",
    timestamp: "",
    trigger: "manual",
    status: {
      current: "",
      progress: "",
      blockers: [],
      nextSteps: [],
    },
    context: {
      keyDecisions: [],
      artifacts: [],
      dependencies: [],
    },
  };

  let currentSection = "";
  let progressLines: string[] = [];

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
        note.taskId = line.split(":")[1]?.trim() ?? "";
      } else if (line.startsWith("- **Timestamp**:")) {
        note.timestamp = line.split(":").slice(1).join(":").trim();
      } else if (line.startsWith("- **Trigger**:")) {
        const trigger = line.split(":")[1]?.trim() as HandoffNote['trigger'];
        note.trigger = trigger;
      } else if (line.startsWith("- **Status**:")) {
        const status = line.split(":")[1]?.trim() ?? "";
        note.status.current = status === "(not specified)" ? "" : status;
      }
    }

    // Progress section (multi-line text)
    if (currentSection === "progress") {
      if (line && !line.startsWith("#")) {
        progressLines.push(line);
      }
    }

    // List sections
    if (line.startsWith("- ") && line !== "- ") {
      const item = line.slice(2);
      
      if (currentSection === "blockers" && item !== "None") {
        note.status.blockers.push(item);
      } else if (currentSection === "next steps" && item !== "None") {
        note.status.nextSteps.push(item);
      } else if (currentSection === "key decisions" && item !== "None") {
        note.context.keyDecisions.push(item);
      } else if (currentSection === "artifacts" && item !== "None") {
        note.context.artifacts.push(item);
      } else if (currentSection === "dependencies" && item !== "None") {
        note.context.dependencies.push(item);
      }
    }
  }

  note.status.progress = progressLines.join("\n");

  return note;
}

/**
 * Write a handoff note to task's outputs/handoff.md.
 * 
 * Formats the note as readable markdown and writes it atomically.
 * Creates the outputs directory if it doesn't exist.
 * 
 * @throws Error if task does not exist
 */
export async function writeHandoff(
  taskId: string,
  note: HandoffNote,
  store: TaskStore
): Promise<void> {
  const markdown = formatHandoffMarkdown(note);
  await store.writeTaskOutput(taskId, "handoff.md", markdown);
}

/**
 * Read the most recent handoff note from task's outputs/handoff.md.
 * 
 * @returns HandoffNote if the file exists, null otherwise
 * @throws Error if task does not exist
 */
export async function readHandoff(
  taskId: string,
  store: TaskStore
): Promise<HandoffNote | null> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const handoffPath = join(
    store.tasksDir,
    task.frontmatter.status,
    taskId,
    "outputs",
    "handoff.md"
  );

  try {
    const content = await readFile(handoffPath, "utf-8");
    return parseHandoffMarkdown(content);
  } catch (err) {
    // File doesn't exist
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
