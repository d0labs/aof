/**
 * Context Manifest — JSON manifest loading, saving, and generation.
 * 
 * Supports storing context layer definitions as `context-manifest.json`
 * in task inputs directories.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ITaskStore } from "../store/interfaces.js";
import type { ContextManifest } from "./assembler.js";

/**
 * Load manifest from task's inputs/context-manifest.json.
 * 
 * @param taskId - Task identifier
 * @param store - TaskStore instance
 * @returns Parsed manifest or null if not found
 * @throws Error if manifest exists but is invalid
 */
export async function loadManifest(
  taskId: string,
  store: TaskStore
): Promise<ContextManifest | null> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Determine inputs directory path
  const taskBaseDir = task.path 
    ? task.path.substring(0, task.path.lastIndexOf('/'))
    : join((store as any).tasksDir, task.frontmatter.status);
  const inputsDir = join(taskBaseDir, taskId, "inputs");
  const manifestPath = join(inputsDir, "context-manifest.json");

  try {
    const content = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(content) as ContextManifest;

    // Validate manifest structure
    validateManifest(manifest);

    return manifest;
  } catch (err: any) {
    // File not found is expected - return null
    if (err.code === "ENOENT") {
      return null;
    }
    // Re-throw parsing/validation errors
    throw new Error(`Failed to load manifest for task ${taskId}`, { cause: err });
  }
}

/**
 * Save manifest to task's inputs/context-manifest.json.
 * 
 * Creates inputs directory if it doesn't exist.
 * 
 * @param taskId - Task identifier
 * @param manifest - Manifest to save
 * @param store - TaskStore instance
 */
export async function saveManifest(
  taskId: string,
  manifest: ContextManifest,
  store: TaskStore
): Promise<void> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Validate before saving
  validateManifest(manifest);

  // Determine inputs directory path
  const taskBaseDir = task.path
    ? task.path.substring(0, task.path.lastIndexOf('/'))
    : join((store as any).tasksDir, task.frontmatter.status);
  const inputsDir = join(taskBaseDir, taskId, "inputs");
  
  // Ensure inputs directory exists
  await mkdir(inputsDir, { recursive: true });

  const manifestPath = join(inputsDir, "context-manifest.json");
  const content = JSON.stringify(manifest, null, 2);

  await writeFile(manifestPath, content, "utf-8");
}

/**
 * Generate a default manifest from task structure.
 * 
 * Creates a manifest with task card + input files in seed layer,
 * empty optional and deep layers.
 * 
 * @param taskId - Task identifier
 * @param inputFiles - List of input file names
 * @returns Generated manifest
 */
export function generateDefaultManifest(
  taskId: string,
  inputFiles: string[]
): ContextManifest {
  const seed: string[] = [
    // Task card path (simplified - actual path varies by status)
    `tasks/backlog/${taskId}.md`,
  ];

  // Add input files to seed layer
  for (const filename of inputFiles) {
    seed.push(`${taskId}/inputs/${filename}`);
  }

  return {
    version: "v1",
    taskId,
    layers: {
      seed,
      optional: [],
      deep: [],
    },
  };
}

/**
 * Validate manifest structure.
 * 
 * @param manifest - Manifest to validate
 * @throws Error if manifest is invalid
 */
function validateManifest(manifest: any): asserts manifest is ContextManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest must be an object");
  }

  if (manifest.version !== "v1") {
    throw new Error("Manifest version must be 'v1'");
  }

  if (!manifest.taskId || typeof manifest.taskId !== "string") {
    throw new Error("Manifest must have a taskId string");
  }

  if (!manifest.layers || typeof manifest.layers !== "object") {
    throw new Error("Manifest must have layers object");
  }

  const { layers } = manifest;
  
  if (!Array.isArray(layers.seed)) {
    throw new Error("Manifest layers.seed must be an array");
  }

  if (!Array.isArray(layers.optional)) {
    throw new Error("Manifest layers.optional must be an array");
  }

  if (!Array.isArray(layers.deep)) {
    throw new Error("Manifest layers.deep must be an array");
  }
}
