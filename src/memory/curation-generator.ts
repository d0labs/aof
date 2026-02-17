/**
 * Memory curation task generator — deterministic task creation based on
 * adaptive pressure thresholds.
 * 
 * Creates curation tasks when entry counts exceed thresholds and sufficient
 * time has passed since the last run. Includes deduplication logic.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { Task } from "../schemas/task.js";
import type {
  CurationPolicy,
  CurationThreshold,
  CurationGuardrails,
} from "./curation-policy.js";
import {
  parseDuration,
  getPoolThresholds,
  getPoolGuardrails,
} from "./curation-policy.js";
import type { MemoryBackend } from "./host-detection.js";

/** Curation scope (pool or project). */
export interface CurationScope {
  type: "pool" | "project";
  id: string;
  entryCount: number;
}

/** Result of curation task generation. */
export interface CurationGenerationResult {
  tasksCreated: Task[];
  skipped: Array<{ scope: CurationScope; reason: string }>;
  warnings: string[];
}

/** Options for curation generation. */
export interface CurationGenerationOptions {
  /** Current timestamp (for testing). */
  now?: Date;
  /** Dry run mode (don't create tasks). */
  dryRun?: boolean;
}

/**
 * Select the appropriate threshold based on entry count.
 * Returns the most aggressive threshold that applies (highest bracket exceeded).
 * Returns null if entry count is below all thresholds.
 * 
 * Logic:
 * - Returns the highest NUMERIC threshold exceeded
 * - Ignores null thresholds (reserved for future use / extreme cases)
 */
export function selectThreshold(
  entryCount: number,
  thresholds: CurationThreshold[]
): CurationThreshold | null {
  let lastExceeded: CurationThreshold | null = null;
  
  for (const threshold of thresholds) {
    // Skip null thresholds for now (reserved for extreme cases)
    if (threshold.maxEntries === null) {
      continue;
    }
    
    if (entryCount > threshold.maxEntries) {
      lastExceeded = threshold;
    } else {
      // Entry count is below this threshold, stop
      break;
    }
  }
  
  return lastExceeded;
}

/**
 * Check if an open curation task exists for the given scope.
 */
async function hasOpenCurationTask(
  store: ITaskStore,
  scopeId: string
): Promise<boolean> {
  const openStatuses = ["backlog", "ready", "in-progress", "blocked", "review"];
  
  for (const status of openStatuses) {
    const tasks = await store.list({ status: status as any });
    const match = tasks.find(
      t =>
        t.frontmatter.metadata.type === "curation" &&
        t.frontmatter.metadata.scopeId === scopeId
    );
    if (match) return true;
  }
  
  return false;
}

/**
 * Get the last completed curation task for a scope.
 */
async function getLastDoneCurationTask(
  store: ITaskStore,
  scopeId: string
): Promise<Task | null> {
  const doneTasks = await store.list({ status: "done" });
  
  const curationTasks = doneTasks.filter(
    t =>
      t.frontmatter.metadata.type === "curation" &&
      t.frontmatter.metadata.scopeId === scopeId
  );
  
  // Sort by lastTransitionAt descending
  curationTasks.sort((a, b) => {
    const aTime = new Date(a.frontmatter.lastTransitionAt).getTime();
    const bTime = new Date(b.frontmatter.lastTransitionAt).getTime();
    return bTime - aTime;
  });
  
  return curationTasks[0] ?? null;
}

/**
 * Check if sufficient time has passed since the last done task.
 */
function shouldRunBasedOnInterval(
  lastTask: Task | null,
  threshold: CurationThreshold,
  now: Date
): boolean {
  if (!lastTask) return true;
  
  const intervalMs = parseDuration(threshold.interval);
  const lastRunTime = new Date(lastTask.frontmatter.lastTransitionAt).getTime();
  const nextRunTime = lastRunTime + intervalMs;
  
  return now.getTime() >= nextRunTime;
}

/**
 * Build task body from template.
 */
function buildTaskBody(
  scope: CurationScope,
  backend: MemoryBackend,
  threshold: CurationThreshold,
  guardrails: CurationGuardrails,
  strategy: string,
  policyPath?: string
): string {
  const maxEntriesText = threshold.maxEntries === null 
    ? "∞" 
    : threshold.maxEntries.toString();
  
  const policyInfo = policyPath 
    ? `**Policy:** \`${policyPath}\`` 
    : "";

  return `## Instructions

Curate the ${scope.type} \`${scope.id}\` to reduce entry count pressure.

**Current State:**
- Entry count: ${scope.entryCount}
- Threshold: ${maxEntriesText} entries
- Interval: ${threshold.interval}
- Backend: ${backend}
- Strategy: ${strategy}

${policyInfo}

**Guardrails:**
- Preserve tags: ${guardrails.preserveTags.length > 0 ? guardrails.preserveTags.join(", ") : "none"}
- Preserve recent: ${guardrails.preserveRecent ?? "none"}
- Min entries: ${guardrails.minEntries ?? 0}
- Max delete per run: ${guardrails.maxDeletePerRun ?? "unlimited"}

**Actions:**
1. Review memory entries for ${scope.id}
2. Apply curation strategy: ${strategy}
3. Respect guardrails (do NOT delete preserved entries)
4. Document deleted/archived entries in task outputs
5. Update entry count in task metadata

## Guidance

**Strategy: ${strategy}**
${strategy === "prune" ? "- Delete stale/low-value entries permanently" : ""}
${strategy === "archive" ? "- Move entries to cold tier (archive)" : ""}
${strategy === "compress" ? "- Compress/summarize entries to reduce size" : ""}

**Verification:**
- Ensure minEntries is respected
- Check that preserved tags/recency rules are honored
- Validate no active/hot entries are removed

**Completion Criteria:**
- Entry count reduced below threshold OR max delete per run reached
- All deletions documented in outputs/
- No violations of guardrails
`;
}

/**
 * Generate curation tasks for the given scopes.
 */
export async function generateCurationTasks(
  store: ITaskStore,
  policy: CurationPolicy,
  scopes: CurationScope[],
  backend: MemoryBackend,
  policyPath: string,
  opts: CurationGenerationOptions = {}
): Promise<CurationGenerationResult> {
  const now = opts.now ?? new Date();
  const tasksCreated: Task[] = [];
  const skipped: Array<{ scope: CurationScope; reason: string }> = [];
  const warnings: string[] = [];

  for (const scope of scopes) {
    // Get pool-specific thresholds and guardrails
    const thresholds = getPoolThresholds(policy, scope.id);
    const guardrails = getPoolGuardrails(policy, scope.id);

    // Check if curation is disabled for this pool
    if (thresholds.length === 0) {
      skipped.push({ scope, reason: "Curation disabled for this pool" });
      continue;
    }

    // Select threshold based on entry count
    const threshold = selectThreshold(scope.entryCount, thresholds);
    if (!threshold) {
      skipped.push({ scope, reason: "No threshold exceeded" });
      continue;
    }

    // Check for open curation task
    const hasOpen = await hasOpenCurationTask(store, scope.id);
    if (hasOpen) {
      skipped.push({ scope, reason: "Open curation task already exists" });
      continue;
    }

    // Check interval gating
    const lastTask = await getLastDoneCurationTask(store, scope.id);
    if (!shouldRunBasedOnInterval(lastTask, threshold, now)) {
      const nextRun = lastTask
        ? new Date(
            new Date(lastTask.frontmatter.lastTransitionAt).getTime() +
            parseDuration(threshold.interval)
          ).toISOString()
        : "unknown";
      skipped.push({
        scope,
        reason: `Interval not met (next run: ${nextRun})`,
      });
      continue;
    }

    // Create the task (unless dry-run)
    if (opts.dryRun) {
      tasksCreated.push({
        frontmatter: {
          schemaVersion: 1,
          id: "DRY-RUN",
          project: store.projectId,
          title: `[DRY-RUN] Curate ${scope.type} ${scope.id}`,
          status: "backlog",
          priority: "normal",
          routing: { role: "memory-curator", tags: ["memory", "curation"] },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lastTransitionAt: now.toISOString(),
          createdBy: "curation-generator",
          dependsOn: [],
          gateHistory: [],
          tests: [],
          metadata: {
            type: "curation",
            backend,
            scopeType: scope.type,
            scopeId: scope.id,
            entryCount: scope.entryCount,
            threshold: {
              maxEntries: threshold.maxEntries,
              interval: threshold.interval,
            },
            guardrails,
            strategy: policy.strategy,
            policyPath,
          },
        },
        body: buildTaskBody(
          scope,
          backend,
          threshold,
          guardrails,
          policy.strategy,
          policyPath
        ),
      });
    } else {
      const task = await store.create({
        title: `Curate ${scope.type} ${scope.id}`,
        body: buildTaskBody(
          scope,
          backend,
          threshold,
          guardrails,
          policy.strategy,
          policyPath
        ),
        priority: "normal",
        routing: {
          role: "memory-curator",
          tags: ["memory", "curation"],
        },
        metadata: {
          type: "curation",
          backend,
          scopeType: scope.type,
          scopeId: scope.id,
          entryCount: scope.entryCount,
          threshold: {
            maxEntries: threshold.maxEntries,
            interval: threshold.interval,
          },
          guardrails,
          strategy: policy.strategy,
          policyPath,
        },
        createdBy: "curation-generator",
      });

      // Transition to ready immediately
      const readyTask = await store.transition(task.frontmatter.id, "ready", {
        reason: "Curation task ready for assignment",
      });

      tasksCreated.push(readyTask);
    }
  }

  return { tasksCreated, skipped, warnings };
}
