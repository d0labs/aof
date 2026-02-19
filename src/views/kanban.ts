import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { stringify as stringifyYaml } from "yaml";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { TaskStoreHooks } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";

export type KanbanSwimlane = "priority" | "project" | "phase";

export interface KanbanViewOptions {
  dataDir: string;
  viewsDir?: string;
  swimlaneBy: KanbanSwimlane;
}

export interface KanbanViewResult {
  swimlanes: string[];
  pointerCount: number;
  removedCount: number;
}

const KANBAN_COLUMNS: readonly TaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
] as const;

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function resolveAssignedAgent(task: Task): string | undefined {
  if (task.frontmatter.lease?.agent) return task.frontmatter.lease.agent;
  if (task.frontmatter.routing.agent) return task.frontmatter.routing.agent;
  const assignee = task.frontmatter.metadata?.assignee;
  return typeof assignee === "string" ? assignee : undefined;
}

function resolveSwimlane(task: Task, mode: KanbanSwimlane): string {
  if (mode === "priority") return task.frontmatter.priority;
  if (mode === "phase") {
    const phase = task.frontmatter.metadata?.phase;
    if (typeof phase === "string" && phase.trim()) return phase.trim();
    if (typeof phase === "number") return String(phase);
    return "unassigned";
  }
  const project = task.frontmatter.metadata?.project;
  if (typeof project === "string" && project.trim()) return project.trim();
  return "unassigned";
}

function normalizeSwimlane(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "unassigned";
  return trimmed
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-");
}

function renderPointer(task: Task, agent: string | undefined, lane: string, canonicalPath: string): string {
  const frontmatter = {
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    status: task.frontmatter.status,
    priority: task.frontmatter.priority,
    agent,
    swimlane: lane,
  };
  const yaml = stringifyYaml(frontmatter, { lineWidth: 120 }).trimEnd();
  return `---\n${yaml}\n---\n\n# ${task.frontmatter.title}\nCanonical: ${canonicalPath}\n`;
}

async function writeIfChanged(filePath: string, contents: string): Promise<void> {
  try {
    const existing = await readFile(filePath, "utf-8");
    if (existing === contents) return;
  } catch {
    // Missing or unreadable: overwrite.
  }

  await writeFileAtomic(filePath, contents);
}

async function pruneDir(dir: string, keep: Set<string>): Promise<number> {
  let removed = 0;
  let entries: string[] = [];

  try {
    entries = await readdir(dir);
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (keep.has(entry)) continue;
    await rm(join(dir, entry), { force: true });
    removed += 1;
  }

  return removed;
}

function resolveTaskPath(task: Task, store: ITaskStore): string {
  if (task.path) return task.path;
  return join(store.tasksDir, task.frontmatter.status, `${task.frontmatter.id}.md`);
}

export async function syncKanbanView(
  store: ITaskStore,
  options: KanbanViewOptions,
): Promise<KanbanViewResult> {
  const baseDir = options.viewsDir ?? join(options.dataDir, "views", "kanban");
  const kanbanRoot = join(baseDir, options.swimlaneBy);
  const tasks = await store.list();

  const desired = new Map<string, Map<TaskStatus, Task[]>>();

  for (const task of tasks) {
    const lane = resolveSwimlane(task, options.swimlaneBy);
    const normalized = normalizeSwimlane(lane);
    const byStatus = desired.get(normalized) ?? new Map<TaskStatus, Task[]>();
    const bucket = byStatus.get(task.frontmatter.status) ?? [];
    bucket.push(task);
    byStatus.set(task.frontmatter.status, bucket);
    desired.set(normalized, byStatus);
  }

  let existingLanes: string[] = [];
  try {
    const entries = await readdir(kanbanRoot, { withFileTypes: true });
    existingLanes = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    // Root missing; we'll create as needed.
  }

  const lanesToProcess = new Set<string>([...existingLanes, ...desired.keys()]);
  let pointerCount = 0;
  let removedCount = 0;

  for (const lane of lanesToProcess) {
    const byStatus = desired.get(lane) ?? new Map<TaskStatus, Task[]>();

    for (const status of KANBAN_COLUMNS) {
      const tasksForColumn = byStatus.get(status) ?? [];
      const dir = join(kanbanRoot, lane, status);
      await mkdir(dir, { recursive: true });

      const keep = new Set<string>();
      for (const task of tasksForColumn) {
        const fileName = `${task.frontmatter.id}.md`;
        keep.add(fileName);

        const taskPath = resolveTaskPath(task, store);
        const canonicalRel = toPosixPath(relative(dir, taskPath));
        const agent = resolveAssignedAgent(task);
        const contents = renderPointer(task, agent, lane, canonicalRel);
        await writeIfChanged(join(dir, fileName), contents);
        pointerCount += 1;
      }

      removedCount += await pruneDir(dir, keep);
    }
  }

  return {
    swimlanes: Array.from(lanesToProcess).sort(),
    pointerCount,
    removedCount,
  };
}

export function createKanbanHooks(
  getStore: () => ITaskStore,
  options: KanbanViewOptions,
): TaskStoreHooks {
  return {
    afterTransition: async () => {
      await syncKanbanView(getStore(), options);
    },
  };
}
