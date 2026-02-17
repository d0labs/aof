/**
 * Task parsing and serialization utilities.
 * Pure functions for converting between Markdown files and Task objects.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { TaskFrontmatter, Task } from "../schemas/task.js";

const FRONTMATTER_FENCE = "---";

/** Parse a Markdown file with YAML frontmatter into Task. */
export function parseTaskFile(raw: string, filePath?: string): Task {
  const lines = raw.split("\n");

  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    throw new Error("Task file must start with YAML frontmatter (---)");
  }

  const endIdx = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (endIdx === -1) {
    throw new Error("Unterminated YAML frontmatter (missing closing ---)");
  }

  const yamlBlock = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n").trim();
  const rawFrontmatter = parseYaml(yamlBlock) as unknown;
  const frontmatter = TaskFrontmatter.parse(rawFrontmatter);

  return { frontmatter, body, path: filePath };
}

/** Serialize a Task back to Markdown with YAML frontmatter. */
export function serializeTask(task: Task): string {
  const yaml = stringifyYaml(task.frontmatter, { lineWidth: 120 });
  return `${FRONTMATTER_FENCE}\n${yaml}${FRONTMATTER_FENCE}\n\n${task.body}\n`;
}

/**
 * Extract Instructions and Guidance sections from a task body.
 * 
 * Returns an object with optional `instructions` and `guidance` properties.
 * Empty string means section header exists but no content.
 * Undefined means section header does not exist.
 * Case-insensitive section matching.
 */
export function extractTaskSections(body: string): {
  instructions?: string;
  guidance?: string;
} {
  const lines = body.split("\n");
  let state: "none" | "instructions" | "guidance" | "other" = "none";
  const instructionLines: string[] = [];
  const guidanceLines: string[] = [];
  let instructionsFound = false;
  let guidanceFound = false;

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();

    if (trimmed.startsWith("## instructions")) {
      state = "instructions";
      instructionsFound = true;
      continue;
    }

    if (trimmed.startsWith("## guidance")) {
      state = "guidance";
      guidanceFound = true;
      continue;
    }

    if (trimmed.startsWith("##")) {
      state = "other";
      continue;
    }

    if (state === "instructions") {
      instructionLines.push(line);
    } else if (state === "guidance") {
      guidanceLines.push(line);
    }
  }

  return {
    instructions: instructionsFound ? instructionLines.join("\n").trim() : undefined,
    guidance: guidanceFound ? guidanceLines.join("\n").trim() : undefined,
  };
}

/**
 * Compute content hash for dependency tracking.
 * Hash excludes frontmatter metadata (focuses on task body and instructions).
 */
export function contentHash(body: string): string {
  const sections = extractTaskSections(body);
  const normalized = [sections.instructions ?? "", sections.guidance ?? ""].join("\n").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
