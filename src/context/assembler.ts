/**
 * Context Assembler — builds context bundles from task cards + inputs.
 * 
 * Reads task card frontmatter + body, all files in inputs/, and assembles
 * into a structured bundle with manifest and character budget support.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ITaskStore } from "../store/interfaces.js";
import { FilesystemResolver, ResolverChain } from "./resolvers.js";
import { loadManifest, generateDefaultManifest } from "./manifest.js";

export interface ContextManifest {
  version: 'v1';
  taskId: string;
  layers: {
    seed: string[];      // Always included (task card, inputs/)
    optional: string[];  // Included if budget allows
    deep: string[];      // Only on explicit request
  };
}

export interface ContextBundle {
  summary: string;       // Assembled context as a single string
  manifest: ContextManifest;
  totalChars: number;
  sources: string[];     // Paths that were resolved
}

export interface AssembleOptions {
  maxChars?: number;        // Character budget limit
  includeDeep?: boolean;    // Include deep layer (default: false)
  resolvers?: ResolverChain; // Custom resolvers (default: FilesystemResolver)
}

/**
 * Assemble context bundle from task card + inputs directory.
 * 
 * @param taskId - Task identifier
 * @param store - TaskStore instance
 * @param opts - Assembly options (maxChars, includeDeep, resolvers)
 * @returns Assembled context bundle
 */
export async function assembleContext(
  taskId: string,
  store: ITaskStore,
  opts?: AssembleOptions
): Promise<ContextBundle> {
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Setup default resolver chain if not provided
  const taskBaseDir = task.path
    ? task.path.substring(0, task.path.lastIndexOf('/'))
    : join((store as any).tasksDir, task.frontmatter.status);
  
  const resolvers = opts?.resolvers ?? new ResolverChain([
    new FilesystemResolver(taskBaseDir),
  ]);

  // Try to load manifest; fall back to legacy behavior
  let manifest = await loadManifest(taskId, store);
  const usingManifest = manifest !== null;

  if (!manifest) {
    // Legacy path: generate default manifest from inputs directory
    const inputFiles = await store.getTaskInputs(taskId);
    manifest = generateDefaultManifest(taskId, inputFiles);
  }

  // Assemble context by resolving layers
  const sources: string[] = [];
  let summary = "";
  const maxChars = opts?.maxChars;

  // Helper to add content with budget checks
  const addContent = (label: string, content: string, ref: string): boolean => {
    const section = `## ${label}\n\n${content}\n\n`;
    
    if (maxChars) {
      const projectedLength = summary.length + section.length;
      if (projectedLength > maxChars) {
        // Try partial inclusion
        const remaining = maxChars - summary.length;
        if (remaining > 100) { // Only include if meaningful space remains
          summary += section.substring(0, remaining);
          summary += "\n\n[Content truncated due to character budget]\n";
        }
        return false; // Signal budget exhausted
      }
    }
    
    summary += section;
    sources.push(ref);
    return true; // Signal continue processing
  };

  // Special handling for task card (always first)
  const taskCardPath = task.path ?? `tasks/${task.frontmatter.status}/${taskId}.md`;
  const frontmatterYaml = stringifyYaml(task.frontmatter, { lineWidth: 120 });
  let taskSection = `# Task: ${task.frontmatter.title}\n\n`;
  taskSection += `## Metadata\n\`\`\`yaml\n${frontmatterYaml}\`\`\`\n\n`;
  taskSection += `## Description\n${task.body}\n\n`;
  
  summary += taskSection;
  sources.push(taskCardPath);

  // Resolve seed layer
  for (const ref of manifest.layers.seed) {
    // Skip task card if already included
    if (ref === taskCardPath || ref.endsWith(`${taskId}.md`)) {
      continue;
    }
    
    try {
      const content = await resolvers.resolve(ref);
      const label = ref.includes('/') ? ref.split('/').pop()! : ref;
      if (!addContent(`Input: ${label}`, content, ref)) {
        break; // Budget exhausted
      }
    } catch (err) {
      // Skip unresolvable refs (allows manifest to list missing files)
      continue;
    }
  }

  // Resolve optional layer (if budget allows)
  if (summary.length < (maxChars ?? Infinity)) {
    for (const ref of manifest.layers.optional) {
      try {
        const content = await resolvers.resolve(ref);
        const label = ref.includes('/') ? ref.split('/').pop()! : ref;
        if (!addContent(`Optional: ${label}`, content, ref)) {
          break; // Budget exhausted
        }
      } catch (err) {
        continue;
      }
    }
  }

  // Resolve deep layer (only if explicitly requested)
  if (opts?.includeDeep && summary.length < (maxChars ?? Infinity)) {
    for (const ref of manifest.layers.deep) {
      try {
        const content = await resolvers.resolve(ref);
        const label = ref.includes('/') ? ref.split('/').pop()! : ref;
        if (!addContent(`Deep: ${label}`, content, ref)) {
          break; // Budget exhausted
        }
      } catch (err) {
        continue;
      }
    }
  }

  // Final budget enforcement
  const truncationNotice = "\n\n[Content truncated due to character budget]\n";
  if (maxChars && summary.length > maxChars) {
    const availableChars = maxChars - truncationNotice.length;
    summary = summary.substring(0, availableChars) + truncationNotice;
  }

  return {
    summary,
    manifest,
    totalChars: summary.length,
    sources,
  };
}
