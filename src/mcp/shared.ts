import { join } from "node:path";
import type { Task, TaskStatus, TaskPriority } from "../schemas/task.js";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import type { GatewayAdapter } from "../dispatch/executor.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export interface AofMcpOptions {
  dataDir: string;
  store?: ITaskStore;
  logger?: EventLogger;
  executor?: GatewayAdapter;
  orgChartPath?: string;
  /** Project ID (for project-scoped operations, defaults to _inbox). */
  projectId?: string;
  /** Vault root (for project-scoped operations). */
  vaultRoot?: string;
}

export interface AofMcpContext {
  dataDir: string;
  store: ITaskStore;
  logger: EventLogger;
  executor?: GatewayAdapter;
  orgChartPath: string;
}

export async function createAofMcpContext(options: AofMcpOptions): Promise<AofMcpContext> {
  let store: ITaskStore;
  let dataDir: string;
  let logger: EventLogger;
  let orgChartPath: string;

  // If projectId is provided, use project-scoped store
  if (options.projectId || options.vaultRoot) {
    const { createProjectStore } = await import("../cli/project-utils.js");
    const projectId = options.projectId ?? "_inbox";
    const vaultRoot = options.vaultRoot ?? options.dataDir;
    const resolution = await createProjectStore({ projectId, vaultRoot, logger: options.logger });
    
    store = options.store ?? resolution.store;
    dataDir = resolution.projectRoot;
    logger = options.logger ?? new EventLogger(join(dataDir, "events"));
    orgChartPath = options.orgChartPath ?? join(resolution.vaultRoot, "org", "org-chart.yaml");
  } else {
    // Legacy behavior: use dataDir directly
    store = options.store ?? new FilesystemTaskStore(options.dataDir);
    dataDir = options.dataDir;
    logger = options.logger ?? new EventLogger(join(dataDir, "events"));
    orgChartPath = options.orgChartPath ?? join(dataDir, "org", "org-chart.yaml");
  }

  return {
    dataDir,
    store,
    logger,
    executor: options.executor,
    orgChartPath,
  };
}

export async function resolveTask(store: ITaskStore, taskId: string): Promise<Task> {
  const task = await store.get(taskId);
  if (task) return task;
  const byPrefix = await store.getByPrefix(taskId);
  if (byPrefix) return byPrefix;
  throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
}

export function resolveAssignedAgent(task: Task): string | undefined {
  if (task.frontmatter.lease?.agent) return task.frontmatter.lease.agent;
  if (task.frontmatter.routing.agent) return task.frontmatter.routing.agent;
  const assignee = task.frontmatter.metadata?.assignee;
  return typeof assignee === "string" ? assignee : undefined;
}

const STATUS_DIRS: TaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
];

export function parseTaskPath(filePath: string): { taskId: string; status: TaskStatus } | null {
  const normalized = filePath.split("\\").join("/");
  const match = normalized.match(/\/tasks\/([^/]+)\/([^/]+)\.md$/);
  if (!match) return null;
  const status = match[1] as TaskStatus;
  if (!STATUS_DIRS.includes(status)) return null;
  return { status, taskId: match[2] ?? "" };
}

const PRIORITY_MAP: Record<string, TaskPriority> = {
  low: "low",
  medium: "normal",
  normal: "normal",
  high: "high",
  critical: "critical",
};

export function normalizePriority(value?: string): TaskPriority {
  if (!value) return "normal";
  const key = value.toLowerCase();
  return PRIORITY_MAP[key] ?? "normal";
}

export function appendSection(body: string, title: string, lines: string[]): string {
  if (lines.length === 0) return body;
  const section = [`## ${title}`, ...lines].join("\n");
  if (!body.trim()) return section;
  return `${body.trim()}\n\n${section}`;
}

export function formatTimestamp(): string {
  return new Date().toISOString();
}
