/**
 * Task validation and linting operations.
 * 
 * Functions for checking task consistency and integrity.
 * Extracted from FilesystemTaskStore to keep it under size limits.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { EventLogger } from "../events/logger.js";
import { parseTaskFile } from "./task-parser.js";

/** All valid status directories per BRD. */
const STATUS_DIRS: readonly TaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "cancelled",
  "deadletter",
] as const;

/**
 * Lint all tasks in the store for consistency issues.
 * 
 * Checks:
 * - Tasks in non-standard directories
 * - Status mismatch between frontmatter and directory
 * - Lease consistency (active lease should only be on in-progress tasks)
 * - Parse errors
 * 
 * @param tasksDir - Root tasks directory
 * @param statusDir - Function to compute status directory path
 * @param logger - Optional event logger
 * @returns Array of issues found
 */
export async function lintTasks(
  tasksDir: string,
  statusDir: (status: TaskStatus) => string,
  logger?: EventLogger,
): Promise<Array<{ task: Task; issue: string }>> {
  const issues: Array<{ task: Task; issue: string }> = [];
  
  // First check for tasks in non-standard directories
  try {
    const allDirs = await readdir(tasksDir, { withFileTypes: true });
    const standardDirNames = new Set(STATUS_DIRS);
    
    for (const entry of allDirs) {
      if (!entry.isDirectory()) continue;
      if (standardDirNames.has(entry.name as TaskStatus)) continue;
      
      // Found a non-standard directory — check if it contains tasks
      const nonStandardDir = join(tasksDir, entry.name);
      let nonStandardEntries: string[];
      try {
        nonStandardEntries = await readdir(nonStandardDir);
      } catch {
        continue;
      }
      
      for (const file of nonStandardEntries) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(nonStandardDir, file);
        
        issues.push({
          task: { frontmatter: {} as any, body: "", path: filePath },
          issue: `Task in non-standard directory '${entry.name}/' — must be in one of: ${Array.from(STATUS_DIRS).join(", ")}`,
        });
      }
    }
  } catch {
    // tasks directory doesn't exist — that's fine, will be caught elsewhere
  }
  
  for (const status of STATUS_DIRS) {
    const dir = statusDir(status);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(dir, entry);

      try {
        const raw = await readFile(filePath, "utf-8");
        const task = parseTaskFile(raw, filePath);

        // Check status matches directory
        if (task.frontmatter.status !== status) {
          issues.push({
            task,
            issue: `Status mismatch: frontmatter='${task.frontmatter.status}' but file in '${status}/'`,
          });
        }

        // Check lease consistency
        if (task.frontmatter.lease && task.frontmatter.status !== "in-progress") {
          issues.push({
            task,
            issue: `Active lease but status is '${task.frontmatter.status}' (expected in-progress)`,
          });
        }
      } catch (err) {
        issues.push({
          task: { frontmatter: {} as any, body: "", path: filePath },
          issue: `Parse error: ${(err as Error).message}`,
        });
      }
    }
  }

  return issues;
}
