/**
 * Task Seeder — BUG-002 Remediation
 * 
 * Utility to seed tasks from YAML/JSON files into AOF.
 * Useful for:
 * - Re-seeding after data loss
 * - Initial setup
 * - Test data creation
 * - Backlog restoration
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import { aofDispatch, type AOFDispatchInput } from "./aof-tools.js";
import type { TaskPriority } from "../schemas/task.js";

/**
 * Task seed entry (simplified format)
 */
export interface TaskSeedEntry {
  title: string;
  brief: string;
  description?: string;
  agent?: string;
  team?: string;
  role?: string;
  priority?: TaskPriority | "normal";
  tags?: string[];
  dependsOn?: string[];
  parentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Task seed file format
 */
export interface TaskSeedFile {
  version: number;
  seeds: TaskSeedEntry[];
}

/**
 * Seeding result
 */
export interface SeedResult {
  total: number;
  succeeded: number;
  failed: number;
  taskIds: string[];
  errors: Array<{ entry: TaskSeedEntry; error: string }>;
}

/**
 * Seed tasks from a YAML or JSON file
 */
export async function seedTasksFromFile(
  filePath: string,
  store: ITaskStore,
  logger: EventLogger,
  options?: {
    actor?: string;
    dryRun?: boolean;
  }
): Promise<SeedResult> {
  const actor = options?.actor ?? "task-seeder";
  const dryRun = options?.dryRun ?? false;

  // Read and parse file
  const content = await readFile(filePath, "utf-8");
  const data = filePath.endsWith(".json")
    ? JSON.parse(content)
    : parseYaml(content);

  // Validate structure
  if (!data.seeds || !Array.isArray(data.seeds)) {
    throw new Error("Invalid seed file: missing 'seeds' array");
  }

  const seedFile = data as TaskSeedFile;
  const result: SeedResult = {
    total: seedFile.seeds.length,
    succeeded: 0,
    failed: 0,
    taskIds: [],
    errors: [],
  };

  // Process each seed entry
  for (const entry of seedFile.seeds) {
    if (dryRun) {
      console.log(`[DRY RUN] Would create: ${entry.title}`);
      result.succeeded++;
      continue;
    }

    try {
      // Convert seed entry to dispatch input
      const dispatchInput: AOFDispatchInput = {
        title: entry.title,
        brief: entry.brief || entry.description || "",
        description: entry.description,
        agent: entry.agent,
        team: entry.team,
        role: entry.role,
        priority: entry.priority,
        tags: entry.tags,
        dependsOn: entry.dependsOn,
        parentId: entry.parentId,
        metadata: entry.metadata,
        actor,
      };

      // Dispatch task
      const dispatchResult = await aofDispatch({ store, logger }, dispatchInput);

      result.taskIds.push(dispatchResult.taskId);
      result.succeeded++;
      
      console.log(`✓ Created ${dispatchResult.taskId}: ${entry.title}`);
    } catch (error) {
      result.failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push({ entry, error: errorMsg });
      
      console.error(`✗ Failed to create: ${entry.title} — ${errorMsg}`);
    }
  }

  return result;
}

/**
 * Seed tasks from an array (programmatic usage)
 */
export async function seedTasks(
  seeds: TaskSeedEntry[],
  store: ITaskStore,
  logger: EventLogger,
  options?: {
    actor?: string;
    dryRun?: boolean;
  }
): Promise<SeedResult> {
  const actor = options?.actor ?? "task-seeder";
  const dryRun = options?.dryRun ?? false;

  const result: SeedResult = {
    total: seeds.length,
    succeeded: 0,
    failed: 0,
    taskIds: [],
    errors: [],
  };

  for (const entry of seeds) {
    if (dryRun) {
      console.log(`[DRY RUN] Would create: ${entry.title}`);
      result.succeeded++;
      continue;
    }

    try {
      const dispatchInput: AOFDispatchInput = {
        title: entry.title,
        brief: entry.brief || entry.description || "",
        description: entry.description,
        agent: entry.agent,
        team: entry.team,
        role: entry.role,
        priority: entry.priority,
        tags: entry.tags,
        dependsOn: entry.dependsOn,
        parentId: entry.parentId,
        metadata: entry.metadata,
        actor,
      };

      const dispatchResult = await aofDispatch({ store, logger }, dispatchInput);

      result.taskIds.push(dispatchResult.taskId);
      result.succeeded++;
    } catch (error) {
      result.failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push({ entry, error: errorMsg });
    }
  }

  return result;
}

/**
 * Create a minimal seed pack for testing/validation
 */
export function createMinimalSeedPack(): TaskSeedFile {
  return {
    version: 1,
    seeds: [
      {
        title: "Setup AOF monitoring",
        brief: "Configure Prometheus metrics and Grafana dashboards for AOF",
        priority: "high",
        agent: "swe-cloud",
        tags: ["observability", "monitoring"],
      },
      {
        title: "Add drift detection to CI pipeline",
        brief: "Integrate `aof org drift` into deployment workflow",
        priority: "normal",
        agent: "swe-backend",
        tags: ["ci-cd", "automation"],
      },
      {
        title: "Document task lifecycle best practices",
        brief: "Create runbook for common task operations and troubleshooting",
        priority: "low",
        agent: "swe-tech-writer",
        tags: ["documentation"],
      },
    ],
  };
}
