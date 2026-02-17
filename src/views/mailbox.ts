import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { stringify as stringifyYaml } from "yaml";
import type { Task, TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { TaskStoreHooks } from "../store/task-store.js";

export type MailboxFolder = "inbox" | "processing" | "outbox";

export interface MailboxViewOptions {
  dataDir: string;
  agentsDir?: string;
  viewsDir?: string;
}

export interface MailboxViewResult {
  agents: string[];
  pointerCount: number;
  removedCount: number;
}

const MAILBOX_FOLDERS: readonly MailboxFolder[] = [
  "inbox",
  "processing",
  "outbox",
] as const;

const STATUS_TO_MAILBOX: Partial<Record<TaskStatus, MailboxFolder>> = {
  ready: "inbox",
  "in-progress": "processing",
  blocked: "processing",
  review: "outbox",
};

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function resolveAssignedAgent(task: Task): string | undefined {
  if (task.frontmatter.lease?.agent) return task.frontmatter.lease.agent;
  if (task.frontmatter.routing.agent) return task.frontmatter.routing.agent;
  const assignee = task.frontmatter.metadata?.assignee;
  return typeof assignee === "string" ? assignee : undefined;
}

function resolveMailboxFolder(status: TaskStatus): MailboxFolder | undefined {
  return STATUS_TO_MAILBOX[status];
}

function renderPointer(task: Task, agent: string, canonicalPath: string): string {
  const frontmatter = {
    id: task.frontmatter.id,
    title: task.frontmatter.title,
    status: task.frontmatter.status,
    agent,
    priority: task.frontmatter.priority,
  };
  const yaml = stringifyYaml(frontmatter, { lineWidth: 120 }).trimEnd();
  return `---\n${yaml}\n---\n\n# ${task.frontmatter.title}\nCanonical: ${canonicalPath}\n`;
}

async function writeIfChanged(filePath: string, contents: string): Promise<void> {
  try {
    const existing = await readFile(filePath, "utf-8");
    if (existing === contents) return;
  } catch {
    // File missing or unreadable — overwrite below.
  }

  await writeFileAtomic(filePath, contents);
}

async function pruneMailboxDir(dir: string, keep: Set<string>): Promise<number> {
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

export async function syncMailboxView(
  store: ITaskStore,
  options: MailboxViewOptions,
): Promise<MailboxViewResult> {
  const agentsDir = options.viewsDir ?? options.agentsDir ?? join(options.dataDir, "views", "mailbox");
  const tasks = await store.list();

  const desired = new Map<string, Map<MailboxFolder, Task[]>>();

  for (const task of tasks) {
    const agent = resolveAssignedAgent(task);
    if (!agent) continue;
    const mailbox = resolveMailboxFolder(task.frontmatter.status);
    if (!mailbox) continue;

    const byMailbox = desired.get(agent) ?? new Map<MailboxFolder, Task[]>();
    const bucket = byMailbox.get(mailbox) ?? [];
    bucket.push(task);
    byMailbox.set(mailbox, bucket);
    desired.set(agent, byMailbox);
  }

  let existingAgents: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    existingAgents = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    // Agents dir missing — we'll create as needed.
  }

  const agentsToProcess = new Set<string>([...existingAgents, ...desired.keys()]);

  let pointerCount = 0;
  let removedCount = 0;

  for (const agent of agentsToProcess) {
    const byMailbox = desired.get(agent) ?? new Map<MailboxFolder, Task[]>();

    for (const mailbox of MAILBOX_FOLDERS) {
      const tasksForBox = byMailbox.get(mailbox) ?? [];
      const dir = join(agentsDir, agent, mailbox);
      await mkdir(dir, { recursive: true });

      const keep = new Set<string>();
      for (const task of tasksForBox) {
        const fileName = `${task.frontmatter.id}.md`;
        keep.add(fileName);

        const taskPath = resolveTaskPath(task, store);
        const canonicalRel = toPosixPath(relative(dir, taskPath));
        const contents = renderPointer(task, agent, canonicalRel);
        await writeIfChanged(join(dir, fileName), contents);
        pointerCount += 1;
      }

      removedCount += await pruneMailboxDir(dir, keep);
    }
  }

  return {
    agents: Array.from(agentsToProcess).sort(),
    pointerCount,
    removedCount,
  };
}

export function createMailboxHooks(
  getStore: () => TaskStore,
  options: MailboxViewOptions,
): TaskStoreHooks {
  return {
    afterTransition: async () => {
      await syncMailboxView(getStore(), options);
    },
  };
}
