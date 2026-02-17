/**
 * ITaskStore - Interface for task storage implementations
 * 
 * Defines the contract for task persistence and retrieval.
 * Current implementation: FilesystemTaskStore (filesystem-backed with status directories)
 */

import type { Task, TaskStatus } from "../schemas/task.js";

/**
 * Core task store interface.
 * All task storage implementations must implement this contract.
 */
export interface ITaskStore {
  /** Project root directory */
  readonly projectRoot: string;
  
  /** Project identifier (e.g., "AOF") */
  readonly projectId: string;
  
  /** Tasks directory path */
  readonly tasksDir: string;

  /**
   * Initialize the task store.
   * Creates necessary directories and validates structure.
   */
  init(): Promise<void>;

  /**
   * Create a new task.
   * Returns the created Task with generated ID.
   */
  create(opts: {
    title: string;
    body?: string;
    priority?: string;
    routing?: { role?: string; team?: string; agent?: string; tags?: string[] };
    sla?: { maxInProgressMs?: number; onViolation?: "alert" | "block" | "deadletter" };
    metadata?: Record<string, unknown>;
    createdBy: string;
    parentId?: string;
    dependsOn?: string[];
  }): Promise<Task>;

  /**
   * Retrieve a task by exact ID.
   * Returns undefined if not found.
   */
  get(id: string): Promise<Task | undefined>;

  /**
   * Find a task by ID prefix (for CLI convenience).
   * Returns undefined if not found or multiple matches.
   */
  getByPrefix(prefix: string): Promise<Task | undefined>;

  /**
   * List all tasks, optionally filtered.
   */
  list(filters?: {
    status?: TaskStatus;
    agent?: string;
    team?: string;
  }): Promise<Task[]>;

  /**
   * Count tasks by status.
   * Returns a map of status -> count.
   */
  countByStatus(): Promise<Record<string, number>>;

  /**
   * Transition a task to a new status.
   * Validates state machine rules and performs atomic update.
   */
  transition(
    id: string,
    newStatus: TaskStatus,
    opts?: { reason?: string; agent?: string },
  ): Promise<Task>;

  /**
   * Update task body content.
   * Recalculates content hash and updates timestamp.
   */
  updateBody(id: string, body: string): Promise<Task>;

  /**
   * Update task metadata fields.
   * Supports: title, description (body), priority, routing (assignee, team, tags).
   * Validates that task is not in terminal state (done).
   * Emits task.updated event and updates timestamp.
   */
  update(
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
  ): Promise<Task>;

  /**
   * Delete a task file.
   * Use sparingly — prefer transitioning to appropriate status.
   */
  delete(id: string): Promise<boolean>;

  /**
   * Scan for tasks with consistency issues.
   * Returns tasks where frontmatter status doesn't match directory or other violations.
   */
  lint(): Promise<Array<{ task: Task; issue: string }>>;

  /**
   * List all files in the task's inputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  getTaskInputs(id: string): Promise<string[]>;

  /**
   * List all files in the task's outputs/ directory.
   * Returns empty array if task or directory doesn't exist.
   */
  getTaskOutputs(id: string): Promise<string[]>;

  /**
   * Write a file to the task's outputs/ directory.
   * Creates the outputs directory if it doesn't exist.
   */
  writeTaskOutput(id: string, filename: string, content: string): Promise<void>;

  /**
   * Add a dependency to a task.
   * Makes taskId depend on blockerId (taskId cannot start until blockerId is done).
   * Validates that both tasks exist and rejects circular dependencies.
   */
  addDep(taskId: string, blockerId: string): Promise<Task>;

  /**
   * Remove a dependency from a task.
   * Returns the updated task.
   */
  removeDep(taskId: string, blockerId: string): Promise<Task>;
}
