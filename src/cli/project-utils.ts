/**
 * CLI project utilities.
 *
 * Helpers for resolving projects and creating TaskStore instances.
 */

import { join } from "node:path";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { resolveProject } from "../projects/resolver.js";

export interface CreateStoreOptions {
  /** Project ID (defaults to _inbox). */
  projectId?: string;
  /** Vault root (optional, uses AOF_ROOT env or default). */
  vaultRoot?: string;
  /** Event logger (optional). */
  logger?: EventLogger;
}

/**
 * Create a TaskStore for a project scope.
 *
 * @param opts - Store creation options
 * @returns TaskStore instance and project resolution
 */
export async function createProjectStore(
  opts: CreateStoreOptions = {}
): Promise<{ store: ITaskStore; projectRoot: string; vaultRoot: string }> {
  const projectId = opts.projectId ?? "_inbox";
  const resolution = await resolveProject(projectId, opts.vaultRoot);

  const store = new FilesystemTaskStore(resolution.projectRoot, {
    projectId: resolution.projectId,
    logger: opts.logger,
  });

  return {
    store,
    projectRoot: resolution.projectRoot,
    vaultRoot: resolution.vaultRoot,
  };
}

/**
 * Resolve views directory for a project.
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to views directory
 */
export function getViewsDir(projectRoot: string): string {
  return join(projectRoot, "views");
}

/**
 * Resolve mailbox views directory for a project.
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to mailbox views directory
 */
export function getMailboxViewsDir(projectRoot: string): string {
  return join(projectRoot, "views", "mailbox");
}

/**
 * Resolve kanban views directory for a project.
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to kanban views directory
 */
export function getKanbanViewsDir(projectRoot: string): string {
  return join(projectRoot, "views", "kanban");
}
