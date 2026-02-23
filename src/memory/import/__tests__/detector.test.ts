/**
 * Tests for the SQLite source detector.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSqliteSources } from "../detector.js";

describe("detector", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-import-detector-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns SqliteSource array from config with explicit sqlite paths", async () => {
    const memDir = join(tmpDir, "memory");
    await mkdir(memDir);

    // Create fake sqlite files.
    await writeFile(join(memDir, "agent-a.sqlite"), "");
    await writeFile(join(memDir, "agent-b.sqlite"), "");

    const config = {
      agents: {
        list: [
          {
            id: "agent-a",
            workspace: "/ws/agent-a",
            memorySearch: { store: { driver: "sqlite", path: join(memDir, "agent-a.sqlite") } },
          },
          {
            id: "agent-b",
            workspace: "/ws/agent-b",
            memorySearch: { store: { driver: "sqlite", path: join(memDir, "agent-b.sqlite") } },
          },
        ],
        defaults: { workspace: "/ws/default" },
      },
    };
    const configPath = join(tmpDir, "openclaw.json");
    await writeFile(configPath, JSON.stringify(config));

    const sources = await detectSqliteSources({ configPath, memoryDir: memDir });
    expect(sources.length).toBe(2);
    expect(sources.map(s => s.agentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(sources.find(s => s.agentId === "agent-a")?.workspacePath).toBe("/ws/agent-a");
  });

  it("de-duplicates agents that share the same SQLite path", async () => {
    const memDir = join(tmpDir, "memory");
    await mkdir(memDir);
    await writeFile(join(memDir, "shared.sqlite"), "");

    const sharedPath = join(memDir, "shared.sqlite");
    const config = {
      agents: {
        list: [
          { id: "agent-x", workspace: "/ws/x", memorySearch: { store: { driver: "sqlite", path: sharedPath } } },
          { id: "agent-y", workspace: "/ws/y", memorySearch: { store: { driver: "sqlite", path: sharedPath } } },
        ],
        defaults: {},
      },
    };
    const configPath = join(tmpDir, "openclaw.json");
    await writeFile(configPath, JSON.stringify(config));

    const sources = await detectSqliteSources({ configPath, memoryDir: memDir });
    expect(sources.length).toBe(1);
    expect(sources[0]!.agentId).toMatch(/shared:/);
    expect(sources[0]!.agentId).toContain("agent-x");
    expect(sources[0]!.agentId).toContain("agent-y");
  });

  it("handles missing config gracefully — returns filesystem scan results", async () => {
    const memDir = join(tmpDir, "memory");
    await mkdir(memDir);
    await writeFile(join(memDir, "lone-agent.sqlite"), "");

    const sources = await detectSqliteSources({
      configPath: join(tmpDir, "nonexistent.json"),
      memoryDir: memDir,
    });

    expect(sources.length).toBe(1);
    expect(sources[0]!.agentId).toBe("lone-agent");
  });

  it("handles invalid JSON config gracefully — returns filesystem results", async () => {
    const memDir = join(tmpDir, "memory");
    await mkdir(memDir);
    await writeFile(join(memDir, "orphan.sqlite"), "");

    const configPath = join(tmpDir, "bad.json");
    await writeFile(configPath, "not valid json {{{");

    const sources = await detectSqliteSources({ configPath, memoryDir: memDir });
    expect(sources.length).toBe(1);
    expect(sources[0]!.agentId).toBe("orphan");
  });

  it("filters by agentId when agentFilter is set", async () => {
    const memDir = join(tmpDir, "memory");
    await mkdir(memDir);
    await writeFile(join(memDir, "alpha.sqlite"), "");
    await writeFile(join(memDir, "beta.sqlite"), "");

    const sources = await detectSqliteSources({
      configPath: join(tmpDir, "nonexistent.json"),
      memoryDir: memDir,
      agentFilter: "alpha",
    });

    expect(sources.length).toBe(1);
    expect(sources[0]!.agentId).toBe("alpha");
  });

  it("ignores sqlite files that do not exist on disk", async () => {
    const memDir = join(tmpDir, "memory");
    await mkdir(memDir);
    // Only create one of the two referenced files.
    await writeFile(join(memDir, "real.sqlite"), "");

    const config = {
      agents: {
        list: [
          { id: "real", memorySearch: { store: { driver: "sqlite", path: join(memDir, "real.sqlite") } } },
          { id: "ghost", memorySearch: { store: { driver: "sqlite", path: join(memDir, "ghost.sqlite") } } },
        ],
        defaults: {},
      },
    };
    const configPath = join(tmpDir, "openclaw.json");
    await writeFile(configPath, JSON.stringify(config));

    const sources = await detectSqliteSources({ configPath, memoryDir: memDir });
    expect(sources.map(s => s.agentId)).toContain("real");
    expect(sources.map(s => s.agentId)).not.toContain("ghost");
  });
});
