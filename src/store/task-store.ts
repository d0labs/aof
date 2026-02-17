/**
 * Task store — filesystem-backed CRUD for tasks.
 *
 * Tasks are Markdown files with YAML frontmatter.
 * The canonical layout uses status subdirectories:
 *   tasks/<status>/TASK-<id>.md
 *
 * Moving a file between directories = atomic status transition.
 * This is the single source of truth. Views are derived.
 */

import { readFile, writeFile, readdir, mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import writeFileAtomic from "write-file-atomic";
import { TaskFrontmatter, Task, isValidTransition } from "../schemas/task.js";
import type { TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "./interfaces.js";

const FRONTMATTER_FENCE = "---";

/** All valid status directories per BRD. */
const STATUS_DIRS: readonly TaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "deadletter",
] as const;

export interface TaskStoreHooks {
  afterTransition?: (task: Task, previousStatus: TaskStatus) => Promise<void>;
}

export interface TaskStoreOptions {
  hooks?: TaskStoreHooks;
  logger?: import("../events/logger.js").EventLogger;
  projectId?: string;
}

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
  const result: { instructions?: string; guidance?: string } = {};
  
  // Find section headers (case-insensitive)
  const sectionRegex = /^##\s+(.+?)\s*$/i;
  const sections: Array<{ name: string; startLine: number }> = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line?.match(sectionRegex);
    if (match) {
      sections.push({ name: match[1]!.toLowerCase(), startLine: i });
    }
  }
  
  // Extract content for each section
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const nextSection = sections[i + 1];
    const endLine = nextSection ? nextSection.startLine : lines.length;
    
    const contentLines = lines.slice(section.startLine + 1, endLine);
    const content = contentLines.join("\n").trim();
    
    // Store content even if empty (to distinguish from missing section)
    if (section.name === "instructions") {
      result.instructions = content;
    } else if (section.name === "guidance") {
      result.guidance = content;
    }
  }
  
  return result;
}

/** Compute SHA-256 content hash for a task body. */
export function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** Task filename from ID. */
function taskFilename(id: string): string {
  return `${id}.md`;
}

/** Format a date for TASK-YYYY-MM-DD-NNN IDs. */
function formatTaskDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Filesystem-backed task store with status subdirectories.
 *
 * Layout: projectRoot/tasks/<status>/<id>.md
 * Moving a file between status dirs = atomic state transition.
 */
export class FilesystemTaskStore implements ITaskStore {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly tasksDir: string;
  private readonly hooks?: TaskStoreHooks;
  private readonly logger?: import("../events/logger.js").EventLogger;

  constructor(projectRoot: string, opts: TaskStoreOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    // Extract project ID from projectRoot basename (e.g., "AOF" from "/path/to/AOF")
    this.projectId = opts.projectId ?? basename(this.projectRoot);
    this.tasksDir = resolve(this.projectRoot, "tasks");
    this.hooks = opts.hooks;
    this.logger = opts.logger;
  }

  /** Compute the next TASK-YYYY-MM-DD-NNN identifier. */
  private async nextTaskId(now: Date): Promise<string> {
    const date = formatTaskDate(now);
    const prefix = `TASK-${date}-`;
    let max = 0;

    for (const status of STATUS_DIRS) {
      const dir = this.statusDir(status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith(".md")) continue;
        const suffix = entry.slice(prefix.length, prefix.length + 3);
        const value = parseInt(suffix, 10);
        if (!Number.isNaN(value)) {
          max = Math.max(max, value);
        }
      }
    }

    const next = String(max + 1).padStart(3, "0");
    return `${prefix}${next}`;
  }

  /** Ensure all status directories exist. */
  async init(): Promise<void> {
    for (const status of STATUS_DIRS) {
      await mkdir(join(this.tasksDir, status), { recursive: true });
    }
  }

  /** Get the directory path for a status. */
  private statusDir(status: TaskStatus): string {
    return join(this.tasksDir, status);
  }

  /** Get the full file path for a task. */
  private taskPath(id: string, status: TaskStatus): string {
    return join(this.statusDir(status), taskFilename(id));
  }

  /** Get the companion directory path for task artifacts. */
  private taskDir(id: string, status: TaskStatus): string {
    return join(this.statusDir(status), id);
  }

  /** Ensure companion directories exist for a task. */
  private async ensureTaskDirs(id: string, status: TaskStatus): Promise<void> {
    const baseDir = this.taskDir(id, status);
    await mkdir(join(baseDir, "inputs"), { recursive: true });
    await mkdir(join(baseDir, "work"), { recursive: true });
    await mkdir(join(baseDir, "outputs"), { recursive: true });
    await mkdir(join(baseDir, "subtasks"), { recursive: true });
  }

  /** Create a new task. Returns the created Task. */
  /** Create a new task. Returns the created Task. */
  async create(opts: {
    title: string;
    body?: string;
    priority?: string;
    routing?: { role?: string; team?: string; agent?: string; tags?: string[] };
    sla?: { maxInProgressMs?: number; onViolation?: "alert" | "block" | "deadletter" };
    metadata?: Record<string, unknown>;
    createdBy: string;
    parentId?: string;
    dependsOn?: string[];
  }): Promise<Task> {
    const now = new Date();
    const nowIso = now.toISOString();
    const id = await this.nextTaskId(now);
    const body = opts.body ?? "";
    const status: TaskStatus = "backlog";

    const frontmatter = TaskFrontmatter.parse({
      schemaVersion: 1,
      id,
      project: this.projectId,
      title: opts.title,
      status,
      priority: opts.priority ?? "normal",
      routing: {
        role: opts.routing?.role,
        team: opts.routing?.team,
        agent: opts.routing?.agent,
        tags: opts.routing?.tags ?? [],
      },
      sla: opts.sla,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastTransitionAt: nowIso,
      createdBy: opts.createdBy,
      parentId: opts.parentId,
      dependsOn: opts.dependsOn ?? [],
      metadata: opts.metadata ?? {},
      contentHash: contentHash(body),
    });

    const task: Task = { frontmatter, body };
    const filePath = this.taskPath(id, status);
    await writeFileAtomic(filePath, serializeTask(task));
    await this.ensureTaskDirs(id, status);
    task.path = filePath;

    return task;
  }

  /** Find a task by ID across all status directories. */
  async get(id: string): Promise<Task | undefined> {
    for (const status of STATUS_DIRS) {
      const filePath = this.taskPath(id, status);
      try {
        const raw = await readFile(filePath, "utf-8");
        return parseTaskFile(raw, filePath);
      } catch (err) {
        // Check if it's a parse error (file exists but is malformed)
        try {
          await stat(filePath);
          // File exists, so this is a parse error
          const errorMessage = (err as Error).message;
          console.error(`[TaskStore] Parse error in ${filePath}: ${errorMessage}`);
          if (this.logger) {
            await this.logger.logValidationFailed(basename(filePath), errorMessage);
          }
        } catch {
          // File doesn't exist, try next status directory
        }
      }
    }
    return undefined;
  }

  /** Find a task by ID prefix (for CLI convenience). */
  async getByPrefix(prefix: string): Promise<Task | undefined> {
    for (const status of STATUS_DIRS) {
      const dir = this.statusDir(status);
      try {
        const entries = await readdir(dir);
        const match = entries.find((f) => f.startsWith(prefix) && f.endsWith(".md"));
        if (match) {
          const filePath = join(dir, match);
          const raw = await readFile(filePath, "utf-8");
          return parseTaskFile(raw, filePath);
        }
      } catch {
        // Directory might not exist
      }
    }
    return undefined;
  }

  /** List all tasks, optionally filtered. */
  async list(filters?: {
    status?: TaskStatus;
    agent?: string;
    team?: string;
  }): Promise<Task[]> {
    const tasks: Task[] = [];
    const statusesToScan = filters?.status ? [filters.status] : STATUS_DIRS;

    for (const status of statusesToScan) {
      const dir = this.statusDir(status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // Directory doesn't exist
      }

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = join(dir, entry);

        try {
          const s = await stat(filePath);
          if (!s.isFile()) continue;

          const raw = await readFile(filePath, "utf-8");
          const task = parseTaskFile(raw, filePath);

          // Apply filters
          if (filters?.agent && task.frontmatter.lease?.agent !== filters.agent) continue;
          if (filters?.team && task.frontmatter.routing.team !== filters.team) continue;

          tasks.push(task);
        } catch (err) {
          // Skip malformed files but log the error explicitly
          const errorMessage = (err as Error).message;
          console.error(`[TaskStore] Parse error in ${filePath}: ${errorMessage}`);
          
          // Emit validation.failed event
          if (this.logger) {
            await this.logger.logValidationFailed(basename(filePath), errorMessage);
          }
        }
      }
    }

    return tasks;
  }

  /**
   * Count tasks by status.
   * Returns a map of status -> count.
   */
  async countByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const status of STATUS_DIRS) {
      const dir = this.statusDir(status);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        counts[status] = 0;
        continue;
      }

      const taskFiles = entries.filter((entry) => entry.endsWith(".md"));
      counts[status] = taskFiles.length;
    }

    return counts;
  }

  /**
   * Transition a task to a new status.
   * This is the core operation: atomic rename between status directories.
   */
  async transition(
    id: string,
    newStatus: TaskStatus,
    opts?: { reason?: string; agent?: string },
  ): Promise<Task> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const currentStatus = task.frontmatter.status;

    // Idempotent: if already in target state, return early (no-op)
    if (currentStatus === newStatus) {
      return task;
    }

    if (!isValidTransition(currentStatus, newStatus)) {
      throw new Error(
        `Invalid transition: ${currentStatus} → ${newStatus} for task ${id}`,
      );
    }

    const now = new Date().toISOString();
    task.frontmatter.status = newStatus;
    task.frontmatter.updatedAt = now;
    task.frontmatter.lastTransitionAt = now;

    // Clear lease on terminal states and when returning to ready
    if (newStatus === "done" || newStatus === "ready" || newStatus === "backlog") {
      task.frontmatter.lease = undefined;
    }

    const oldPath = task.path ?? this.taskPath(id, currentStatus);
    const newPath = this.taskPath(id, newStatus);

    if (oldPath !== newPath) {
      // Atomic transition: write to old location first, then rename
      // This ensures the file is never missing during the transition
      await writeFileAtomic(oldPath, serializeTask(task));
      
      // Atomic move to new location
      await rename(oldPath, newPath);

      // Move companion directories if present
      const oldDir = this.taskDir(id, currentStatus);
      const newDir = this.taskDir(id, newStatus);
      try {
        await rename(oldDir, newDir);
      } catch {
        // Companion directory missing — ignore
      }
    } else {
      // Same location, just update content atomically
      await writeFileAtomic(newPath, serializeTask(task));
    }

    task.path = newPath;
    
    // Emit transition event
    if (this.logger) {
      await this.logger.logTransition(id, currentStatus, newStatus, opts?.agent ?? "system", opts?.reason);
    }
    
    // Emit task.assigned event if transitioning to in-progress with an agent
    if (newStatus === "in-progress" && opts?.agent) {
      if (this.logger) {
        await this.logger.log("task.assigned", opts.agent, {
          taskId: id,
          payload: { agent: opts.agent },
        });
      }
    }
    
    if (this.hooks?.afterTransition) {
      await this.hooks.afterTransition(task, currentStatus);
    }
    return task;
  }

  /** Update task body content (recalculates content hash). */
  async updateBody(id: string, body: string): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    task.body = body;
    task.frontmatter.contentHash = contentHash(body);
    task.frontmatter.updatedAt = new Date().toISOString();

    const filePath = task.path ?? this.taskPath(id, task.frontmatter.status);
    await writeFileAtomic(filePath, serializeTask(task));

    return task;
  }

  /** Update task metadata fields. */
  async update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      priority?: string;
      routing?: {
        role?: string;
        team?: string;
        agent?: string;
        tags?: string[];
      };
    },
  ): Promise<Task> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Reject updates to terminal states
    const terminalStates: TaskStatus[] = ["done"];
    if (terminalStates.includes(task.frontmatter.status)) {
      throw new Error(
        `Cannot update task ${id}: task is in terminal state '${task.frontmatter.status}'`,
      );
    }

    // Track what changed for event payload
    const changes: Record<string, unknown> = {};

    // Apply patches
    if (patch.title !== undefined) {
      changes.title = { from: task.frontmatter.title, to: patch.title };
      task.frontmatter.title = patch.title;
    }

    if (patch.description !== undefined) {
      changes.description = { from: task.body, to: patch.description };
      task.body = patch.description;
      task.frontmatter.contentHash = contentHash(patch.description);
    }

    if (patch.priority !== undefined) {
      changes.priority = { from: task.frontmatter.priority, to: patch.priority };
      task.frontmatter.priority = patch.priority;
    }

    if (patch.routing !== undefined) {
      const oldRouting = { ...task.frontmatter.routing };
      
      if (patch.routing.role !== undefined) {
        task.frontmatter.routing.role = patch.routing.role;
      }
      if (patch.routing.team !== undefined) {
        task.frontmatter.routing.team = patch.routing.team;
      }
      if (patch.routing.agent !== undefined) {
        task.frontmatter.routing.agent = patch.routing.agent;
      }
      if (patch.routing.tags !== undefined) {
        task.frontmatter.routing.tags = patch.routing.tags;
      }

      changes.routing = { from: oldRouting, to: task.frontmatter.routing };
    }

    // Update timestamp
    task.frontmatter.updatedAt = new Date().toISOString();

    // Persist changes
    const filePath = task.path ?? this.taskPath(id, task.frontmatter.status);
    await writeFileAtomic(filePath, serializeTask(task));

    // Emit task.updated event
    if (this.logger && Object.keys(changes).length > 0) {
      await this.logger.log("task.updated", "system", {
        taskId: id,
        payload: { changes },
      });
    }

    return task;
  }

  /** Delete a task file (use sparingly — prefer cancel status). */
  async delete(id: string): Promise<boolean> {
    const task = await this.get(id);
    if (!task) return false;

    const filePath = task.path ?? this.taskPath(id, task.frontmatter.status);
    try {
      await rm(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scan for tasks with consistency issues.
   * Returns tasks where frontmatter status doesn't match directory.
   */
  async lint(): Promise<Array<{ task: Task; issue: string }>> {
    const issues: Array<{ task: Task; issue: string }> = [];
    
    // First check for tasks in non-standard directories
    try {
      const allDirs = await readdir(this.tasksDir, { withFileTypes: true });
      const standardDirNames = new Set(STATUS_DIRS);
      
      for (const entry of allDirs) {
        if (!entry.isDirectory()) continue;
        if (standardDirNames.has(entry.name as TaskStatus)) continue;
        
        // Found a non-standard directory — check if it contains tasks
        const nonStandardDir = join(this.tasksDir, entry.name);
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
      const dir = this.statusDir(status);
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

  /**
   * List all files in the task's inputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  async getTaskInputs(id: string): Promise<string[]> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const inputsDir = join(this.taskDir(id, task.frontmatter.status), "inputs");
    try {
      const entries = await readdir(inputsDir);
      return entries.filter(entry => entry !== "." && entry !== "..");
    } catch {
      return [];
    }
  }

  /**
   * List all files in the task's outputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  async getTaskOutputs(id: string): Promise<string[]> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const outputsDir = join(this.taskDir(id, task.frontmatter.status), "outputs");
    try {
      const entries = await readdir(outputsDir);
      return entries.filter(entry => entry !== "." && entry !== "..");
    } catch {
      return [];
    }
  }

  /**
   * Write a file to the task's outputs/ directory.
   * Creates the outputs directory if it doesn't exist.
   */
  async writeTaskOutput(id: string, filename: string, content: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const outputsDir = join(this.taskDir(id, task.frontmatter.status), "outputs");
    await mkdir(outputsDir, { recursive: true });
    
    const filePath = join(outputsDir, filename);
    await writeFileAtomic(filePath, content);
  }

  /**
   * Check if adding a dependency would create a cycle.
   * Returns true if blockerId (or any of its transitive dependencies) depends on taskId.
   * Uses DFS to detect cycles in the dependency graph.
   */
  private async hasCycle(taskId: string, blockerId: string): Promise<boolean> {
    const visited = new Set<string>();

    const dfs = async (currentId: string): Promise<boolean> => {
      // If we've reached taskId, there's a cycle
      if (currentId === taskId) {
        return true;
      }

      // Already visited this node in this search path
      if (visited.has(currentId)) {
        return false;
      }

      visited.add(currentId);

      const task = await this.get(currentId);
      if (!task) {
        return false; // Task doesn't exist
      }

      // Check all dependencies recursively
      for (const depId of task.frontmatter.dependsOn) {
        if (await dfs(depId)) {
          return true;
        }
      }

      return false;
    };

    // Check if blockerId (or any of its dependencies) depends on taskId
    // Start DFS from blockerId
    return await dfs(blockerId);
  }

  /**
   * Add a dependency to a task.
   * Makes taskId depend on blockerId (taskId cannot start until blockerId is done).
   */
  async addDep(taskId: string, blockerId: string): Promise<Task> {
    // Validate both tasks exist
    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const blocker = await this.get(blockerId);
    if (!blocker) {
      throw new Error(`Blocker task not found: ${blockerId}`);
    }

    // Reject self-dependency
    if (taskId === blockerId) {
      throw new Error(`Task cannot depend on itself: ${taskId}`);
    }

    // Check if already depends
    if (task.frontmatter.dependsOn.includes(blockerId)) {
      return task; // Idempotent: already has this dependency
    }

    // Check for circular dependencies
    if (await this.hasCycle(taskId, blockerId)) {
      throw new Error(`Adding dependency would create a circular dependency: ${taskId} -> ${blockerId}`);
    }

    // Update task
    task.frontmatter.dependsOn.push(blockerId);
    task.frontmatter.updatedAt = new Date().toISOString();

    // Write atomically
    const filePath = task.path ?? this.taskPath(taskId, task.frontmatter.status);
    await writeFileAtomic(filePath, serializeTask(task));

    // Emit event
    if (this.logger) {
      await this.logger.log("task.dep.added", "system", {
        taskId,
        payload: { taskId, blockerId },
      });
    }

    return task;
  }

  /**
   * Remove a dependency from a task.
   */
  async removeDep(taskId: string, blockerId: string): Promise<Task> {
    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Check if dependency exists
    const index = task.frontmatter.dependsOn.indexOf(blockerId);
    if (index === -1) {
      return task; // Idempotent: dependency doesn't exist
    }

    // Remove dependency
    task.frontmatter.dependsOn.splice(index, 1);
    task.frontmatter.updatedAt = new Date().toISOString();

    // Write atomically
    const filePath = task.path ?? this.taskPath(taskId, task.frontmatter.status);
    await writeFileAtomic(filePath, serializeTask(task));

    // Emit event
    if (this.logger) {
      await this.logger.log("task.dep.removed", "system", {
        taskId,
        payload: { taskId, blockerId },
      });
    }

    return task;
  }
}
