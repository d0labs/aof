import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { RunArtifact, RunHeartbeat, ResumeInfo } from "../schemas/run.js";
import { RunResult } from "../schemas/run-result.js";
import type { ITaskStore } from "../store/interfaces.js";

/**
 * Get the companion directory for a task (where run artifacts live).
 * Run artifacts live in project-scoped state directory.
 */
function getTaskDir(store: ITaskStore, taskId: string): string | undefined {
  // Run artifacts stored in project-scoped state directory
  // Path: <projectRoot>/state/runs/<taskId>/
  const runsDir = join(store.projectRoot, "state", "runs", taskId);
  return runsDir;
}

async function resolveTaskDir(store: ITaskStore, taskId: string): Promise<string | undefined> {
  const task = await store.get(taskId);
  if (!task) return undefined;
  
  // Run artifacts stored in project-scoped state directory
  // Path: <projectRoot>/state/runs/<taskId>/
  const runsDir = join(store.projectRoot, "state", "runs", taskId);
  return runsDir;
}

/**
 * Write run.json artifact when task execution starts.
 */
export async function writeRunArtifact(
  store: ITaskStore,
  taskId: string,
  agentId: string,
  metadata?: Record<string, unknown>,
): Promise<RunArtifact> {
  const taskDir = await resolveTaskDir(store, taskId);
  if (!taskDir) throw new Error(`Task not found: ${taskId}`);

  // Ensure state/runs directory exists before writing
  await mkdir(taskDir, { recursive: true });

  const artifact: RunArtifact = {
    taskId,
    agentId,
    startedAt: new Date().toISOString(),
    status: "running",
    artifactPaths: {
      inputs: "inputs/",
      work: "work/",
      output: "output/",
    },
    metadata: metadata ?? {},
  };

  const filePath = join(taskDir, "run.json");
  await writeFileAtomic(filePath, JSON.stringify(artifact, null, 2));

  return artifact;
}

/**
 * Read run.json artifact.
 */
export async function readRunArtifact(
  store: ITaskStore,
  taskId: string,
): Promise<RunArtifact | undefined> {
  const taskDir = await resolveTaskDir(store, taskId);
  if (!taskDir) return undefined;

  const filePath = join(taskDir, "run.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return RunArtifact.parse(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Write run_result.json artifact when a task completes.
 */
export async function writeRunResult(
  store: ITaskStore,
  taskId: string,
  result: RunResult,
): Promise<RunResult> {
  const taskDir = await resolveTaskDir(store, taskId);
  if (!taskDir) throw new Error(`Task not found: ${taskId}`);

  await mkdir(taskDir, { recursive: true });

  const parsed = RunResult.parse(result);
  if (parsed.taskId !== taskId) {
    throw new Error(`Run result taskId mismatch: expected ${taskId}, got ${parsed.taskId}`);
  }

  const filePath = join(taskDir, "run_result.json");
  await writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));

  return parsed;
}

/**
 * Read run_result.json artifact.
 */
export async function readRunResult(
  store: ITaskStore,
  taskId: string,
): Promise<RunResult | undefined> {
  const taskDir = await resolveTaskDir(store, taskId);
  if (!taskDir) return undefined;

  const filePath = join(taskDir, "run_result.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return RunResult.parse(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Mark run artifact as expired (BUG-AUDIT-003).
 */
export async function markRunArtifactExpired(
  store: ITaskStore,
  taskId: string,
  reason: string,
): Promise<void> {
  const existing = await readRunArtifact(store, taskId);
  if (!existing) return; // No artifact to update

  const taskDir = await resolveTaskDir(store, taskId);
  if (!taskDir) return;

  // Update status to failed (lease expired)
  existing.status = "failed";
  existing.metadata = {
    ...existing.metadata,
    expiredAt: new Date().toISOString(),
    expiredReason: reason,
  };

  const filePath = join(taskDir, "run.json");
  await writeFileAtomic(filePath, JSON.stringify(existing, null, 2));
}

/**
 * Write or update heartbeat.
 */
export async function writeHeartbeat(
  store: ITaskStore,
  taskId: string,
  agentId: string,
  ttlMs: number,
): Promise<RunHeartbeat> {
  const taskDir = await resolveTaskDir(store, taskId);
  if (!taskDir) throw new Error(`Task not found: ${taskId}`);

  // Ensure state/runs directory exists before writing
  await mkdir(taskDir, { recursive: true });

  const filePath = join(taskDir, "run_heartbeat.json");
  
  let existing: RunHeartbeat | undefined;
  try {
    const raw = await readFile(filePath, "utf-8");
    existing = RunHeartbeat.parse(JSON.parse(raw));
  } catch {
    // No existing heartbeat
  }

  const now = new Date();
  const heartbeat: RunHeartbeat = {
    taskId,
    agentId,
    lastHeartbeat: now.toISOString(),
    beatCount: existing ? existing.beatCount + 1 : 0,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  await writeFileAtomic(filePath, JSON.stringify(heartbeat, null, 2));
  return heartbeat;
}

/**
 * Read heartbeat.
 */
export async function readHeartbeat(
  store: ITaskStore,
  taskId: string,
): Promise<RunHeartbeat | undefined> {
  const taskDir = await resolveTaskDir(store, taskId);
  if (!taskDir) return undefined;

  const filePath = join(taskDir, "run_heartbeat.json");
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return RunHeartbeat.parse(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Check all in-progress tasks for stale heartbeats.
 * Returns tasks with expired heartbeats.
 */
export async function checkStaleHeartbeats(
  store: ITaskStore,
  ttlMs: number,
): Promise<RunHeartbeat[]> {
  const inProgress = await store.list({ status: "in-progress" });
  const stale: RunHeartbeat[] = [];
  const now = Date.now();

  for (const task of inProgress) {
    const heartbeat = await readHeartbeat(store, task.frontmatter.id);
    if (!heartbeat) continue;

    const expiresAt = heartbeat.expiresAt ? new Date(heartbeat.expiresAt).getTime() : 0;
    if (expiresAt > 0 && expiresAt <= now) {
      stale.push(heartbeat);
    }
  }

  return stale;
}

/**
 * Get resume info for a task (for crash recovery).
 */
export async function getResumeInfo(
  store: ITaskStore,
  taskId: string,
  ttlMs: number,
): Promise<ResumeInfo> {
  const task = await store.get(taskId);
  if (!task) {
    return {
      taskId,
      agentId: "unknown",
      status: "stale",
      reason: "Task not found",
    };
  }

  if (task.frontmatter.status === "done") {
    return {
      taskId,
      agentId: task.frontmatter.lease?.agent ?? "unknown",
      status: "completed",
      reason: "Task already completed",
    };
  }

  const run = await readRunArtifact(store, taskId);
  const heartbeat = await readHeartbeat(store, taskId);

  if (!run && !heartbeat) {
    return {
      taskId,
      agentId: task.frontmatter.lease?.agent ?? task.frontmatter.routing.agent ?? "unknown",
      status: "resumable",
      reason: "No run artifacts found (never started or cleaned up)",
    };
  }

  if (heartbeat) {
    const expiresAt = heartbeat.expiresAt ? new Date(heartbeat.expiresAt).getTime() : 0;
    const now = Date.now();

    if (expiresAt > 0 && expiresAt <= now) {
      return {
        taskId,
        agentId: heartbeat.agentId,
        status: "stale",
        runArtifact: run,
        heartbeat,
        reason: `Heartbeat expired at ${heartbeat.expiresAt}`,
      };
    }
  }

  return {
    taskId,
    agentId: run?.agentId ?? heartbeat?.agentId ?? "unknown",
    status: "resumable",
    runArtifact: run,
    heartbeat,
  };
}
