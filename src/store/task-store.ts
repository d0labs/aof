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
import writeFileAtomic from "write-file-atomic";
import { TaskFrontmatter, Task, isValidTransition } from "../schemas/task.js";
import type { TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "./interfaces.js";
import { parseTaskFile, serializeTask, extractTaskSections, contentHash } from "./task-parser.js";
import { hasCycle, addDependency, removeDependency } from "./task-deps.js";
import { lintTasks } from "./task-validation.js";
import { getTaskInputs as getInputs, getTaskOutputs as getOutputs, writeTaskOutput as writeOutput } from "./task-file-ops.js";
import { blockTask, unblockTask, cancelTask } from "./task-lifecycle.js";
import { updateTask, type UpdatePatch, transitionTask, type TransitionOpts } from "./task-mutations.js";

const FRONTMATTER_FENCE = "---";

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

export interface TaskStoreHooks {
  afterTransition?: (task: Task, previousStatus: TaskStatus) => Promise<void>;
}

export interface TaskStoreOptions {
  hooks?: TaskStoreHooks;
  logger?: import("../events/logger.js").EventLogger;
  projectId?: string;
}

// Re-export parser functions for public API
export { parseTaskFile, serializeTask, extractTaskSections, contentHash };

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
    opts?: TransitionOpts,
  ): Promise<Task> {
    return transitionTask(
      id,
      newStatus,
      opts,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.taskDir.bind(this),
      this.logger,
      this.hooks,
    );
  }

  /**
   * Cancel a task.
   * Transitions to "cancelled" status, clears any active lease,
   * stores cancellation reason in metadata, and emits task.cancelled event.
   */
  async cancel(id: string, reason?: string): Promise<Task> {
    return cancelTask(
      id,
      reason,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.taskDir.bind(this),
      this.logger,
      this.hooks,
    );
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
  async update(id: string, patch: UpdatePatch): Promise<Task> {
    return updateTask(
      id,
      patch,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
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
    return lintTasks(this.tasksDir, this.statusDir.bind(this), this.logger);
  }

  /**
   * List all files in the task's inputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  async getTaskInputs(id: string): Promise<string[]> {
    return getInputs(id, this.get.bind(this), this.taskDir.bind(this));
  }

  /**
   * List all files in the task's outputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  async getTaskOutputs(id: string): Promise<string[]> {
    return getOutputs(id, this.get.bind(this), this.taskDir.bind(this));
  }

  /**
   * Write a file to the task's outputs/ directory.
   * Creates the outputs directory if it doesn't exist.
   */
  async writeTaskOutput(id: string, filename: string, content: string): Promise<void> {
    return writeOutput(id, filename, content, this.get.bind(this), this.taskDir.bind(this));
  }

  /**
   * Check if adding a dependency would create a cycle.
   * Returns true if blockerId (or any of its transitive dependencies) depends on taskId.
   * Uses DFS to detect cycles in the dependency graph.
   */
  private async hasCycle(taskId: string, blockerId: string): Promise<boolean> {
    return hasCycle(taskId, blockerId, this.get.bind(this));
  }

  /**
   * Add a dependency to a task.
   * Makes taskId depend on blockerId (taskId cannot start until blockerId is done).
   */
  async addDep(taskId: string, blockerId: string): Promise<Task> {
    return addDependency(
      taskId,
      blockerId,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
  }

  /**
   * Remove a dependency from a task.
   */
  async removeDep(taskId: string, blockerId: string): Promise<Task> {
    return removeDependency(
      taskId,
      blockerId,
      this.get.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
  }

  /**
   * Block a task with a reason.
   * Transitions task to blocked state and stores the block reason.
   * Can only block tasks from non-terminal states.
   */
  async block(id: string, reason: string): Promise<Task> {
    return blockTask(
      id,
      reason,
      this.get.bind(this),
      this.transition.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
  }

  /**
   * Unblock a task.
   * Transitions task from blocked to ready and clears the block reason.
   * Can only unblock tasks currently in blocked state.
   */
  async unblock(id: string): Promise<Task> {
    return unblockTask(
      id,
      this.get.bind(this),
      this.transition.bind(this),
      this.taskPath.bind(this),
      this.logger,
    );
  }
}
