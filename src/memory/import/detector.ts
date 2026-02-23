/**
 * Detect SQLite memory sources from openclaw.json and filesystem scan.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { SqliteSource } from "./types.js";

const DEFAULT_MEMORY_DIR = join(homedir(), ".openclaw", "memory");
const DEFAULT_WORKSPACE = join(homedir(), ".openclaw", "workspace");
const DEFAULT_CONFIG = join(homedir(), ".openclaw", "openclaw.json");

// Minimal schema — only the fields we need.
const AgentSchema = z.object({
  id: z.string(),
  workspace: z.string().optional(),
  memorySearch: z.object({
    store: z.object({
      driver: z.string(),
      path: z.string(),
    }).optional(),
  }).optional(),
});

const ConfigSchema = z.object({
  agents: z.object({
    list: z.array(AgentSchema).optional().default([]),
    defaults: z.object({
      workspace: z.string().optional(),
      memorySearch: z.object({
        store: z.object({
          driver: z.string(),
          path: z.string(),
        }).optional(),
      }).optional(),
    }).optional(),
  }).optional().default({}),
});

export interface DetectorOptions {
  configPath?: string;
  memoryDir?: string;
  agentFilter?: string;
}

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

export async function detectSqliteSources(opts: DetectorOptions = {}): Promise<SqliteSource[]> {
  const memoryDir = opts.memoryDir ?? DEFAULT_MEMORY_DIR;
  const configPath = opts.configPath ?? DEFAULT_CONFIG;

  // Map: sqlitePath → SqliteSource (de-duplicate by path).
  const byPath = new Map<string, SqliteSource>();

  // Step 1: Parse config.
  let agentList: z.infer<typeof AgentSchema>[] = [];
  let defaultWorkspace = DEFAULT_WORKSPACE;
  let defaultStore: { driver: string; path: string } | undefined;

  try {
    const raw = await readFile(configPath, "utf-8");
    const config = ConfigSchema.parse(JSON.parse(raw));
    agentList = config.agents.list ?? [];
    defaultWorkspace = config.agents.defaults?.workspace ?? DEFAULT_WORKSPACE;
    defaultStore = config.agents.defaults?.memorySearch?.store;
  } catch {
    // Config missing or invalid — fall through to filesystem scan.
  }

  // Step 2: Map config agents to their SQLite sources.
  for (const agent of agentList) {
    const workspacePath = agent.workspace ?? defaultWorkspace;
    const store = agent.memorySearch?.store ?? defaultStore;

    if (store?.driver === "sqlite" && store.path) {
      const sqlitePath = resolve(store.path);
      if (!byPath.has(sqlitePath)) {
        byPath.set(sqlitePath, { agentId: agent.id, sqlitePath, workspacePath });
      } else {
        // De-duplicate: merge agent IDs.
        const existing = byPath.get(sqlitePath)!;
        if (!existing.agentId.startsWith("shared:")) {
          existing.agentId = `shared:${existing.agentId},${agent.id}`;
        } else {
          existing.agentId = `${existing.agentId},${agent.id}`;
        }
      }
    }
  }

  // Build lookup: agentId → workspacePath for filesystem scan.
  const workspaceByAgent = new Map(agentList.map(a => [a.id, a.workspace ?? defaultWorkspace]));

  // Step 3: Scan memoryDir for *.sqlite files not already captured.
  let sqliteFiles: string[] = [];
  try {
    const entries = await readdir(memoryDir);
    sqliteFiles = entries.filter(f => f.endsWith(".sqlite"));
  } catch {
    // Directory missing — no filesystem sources.
  }

  for (const filename of sqliteFiles) {
    const sqlitePath = join(memoryDir, filename);
    if (byPath.has(sqlitePath)) continue;

    const agentId = filename.replace(/\.sqlite$/, "");
    const workspacePath = workspaceByAgent.get(agentId)
      ?? join(homedir(), ".openclaw", "agents", agentId, "workspace");

    byPath.set(sqlitePath, { agentId, sqlitePath, workspacePath });
  }

  let sources = Array.from(byPath.values());

  // Step 4: Filter by agent if requested.
  if (opts.agentFilter) {
    const filter = opts.agentFilter;
    sources = sources.filter(s => s.agentId === filter || s.agentId.includes(filter));
  }

  // Step 5: Only return files that actually exist.
  const checked = await Promise.all(
    sources.map(async s => ({ s, exists: await fileExists(s.sqlitePath) }))
  );
  return checked.filter(c => c.exists).map(c => c.s);
}
