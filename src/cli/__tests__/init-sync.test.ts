/**
 * Tests for init-sync — bidirectional org chart ↔ OpenClaw agent sync.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

// Mock external dependencies before importing the module under test
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  checkbox: vi.fn().mockImplementation(({ choices }) =>
    Promise.resolve(choices.map((c: { value: string }) => c.value)),
  ),
}));

vi.mock("../../drift/adapters.js", () => ({
  LiveAdapter: vi.fn().mockImplementation(() => ({
    getAgents: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../../packaging/openclaw-cli.js", () => ({
  openclawConfigGet: vi.fn().mockResolvedValue(undefined),
  openclawConfigSet: vi.fn().mockResolvedValue(undefined),
}));

import { runSyncStep } from "../init-sync.js";
import { LiveAdapter } from "../../drift/adapters.js";
import { openclawConfigSet } from "../../packaging/openclaw-cli.js";

function makeOrgChartYaml(agents: Array<Record<string, unknown>> = []): string {
  return stringifyYaml({
    schemaVersion: 1,
    teams: [],
    agents,
    routing: [],
  });
}

describe("runSyncStep", () => {
  let tmpDir: string;
  let orgChartPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "init-sync-"));
    orgChartPath = join(tmpDir, "org-chart.yaml");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips when no OpenClaw agents found", async () => {
    await writeFile(orgChartPath, makeOrgChartYaml());
    // LiveAdapter returns empty
    vi.mocked(LiveAdapter).mockImplementation(
      () => ({ getAgents: vi.fn().mockResolvedValue([]) }) as never,
    );

    const result = await runSyncStep(orgChartPath, true);

    expect(result.imported).toHaveLength(0);
    expect(result.exported).toHaveLength(0);
  });

  it("skips when org chart not found", async () => {
    vi.mocked(LiveAdapter).mockImplementation(
      () => ({
        getAgents: vi.fn().mockResolvedValue([
          { id: "agent:main:main", name: "Main", creature: "cat", active: true },
        ]),
      }) as never,
    );

    const result = await runSyncStep(join(tmpDir, "nonexistent.yaml"), true);

    expect(result.imported).toHaveLength(0);
    expect(result.warnings).toContain("Org chart not found or invalid; sync skipped.");
  });

  it("imports OpenClaw agents not in org chart", async () => {
    await writeFile(
      orgChartPath,
      makeOrgChartYaml([
        { id: "existing", name: "Existing", openclawAgentId: "agent:main:existing" },
      ]),
    );

    const mockAgents = [
      { id: "agent:main:existing", name: "Existing", creature: "cat", active: true },
      { id: "agent:main:new-agent", name: "New Agent", creature: "dog", active: true },
    ];

    vi.mocked(LiveAdapter).mockImplementation(
      () => ({ getAgents: vi.fn().mockResolvedValue(mockAgents) }) as never,
    );

    const result = await runSyncStep(orgChartPath, true);

    expect(result.imported).toContain("agent:main:new-agent");

    // Verify the YAML was updated
    const updated = parseYaml(await readFile(orgChartPath, "utf-8")) as {
      agents: Array<{ id: string; openclawAgentId?: string }>;
    };
    const ids = updated.agents.map((a) => a.openclawAgentId).filter(Boolean);
    expect(ids).toContain("agent:main:new-agent");
  });

  it("exports org chart agents not in OpenClaw", async () => {
    await writeFile(
      orgChartPath,
      makeOrgChartYaml([
        {
          id: "local-only",
          name: "Local Only",
          openclawAgentId: "agent:main:local-only",
          active: true,
        },
      ]),
    );

    // No OpenClaw agents match
    const mockAgents = [
      { id: "agent:main:other", name: "Other", creature: "cat", active: true },
    ];

    vi.mocked(LiveAdapter).mockImplementation(
      () => ({ getAgents: vi.fn().mockResolvedValue(mockAgents) }) as never,
    );

    const result = await runSyncStep(orgChartPath, true);

    expect(result.exported).toContain("local-only");
    expect(openclawConfigSet).toHaveBeenCalledWith(
      "agents.agent:main:local-only",
      expect.objectContaining({ name: "Local Only" }),
    );
  });

  it("is idempotent — no changes when already in sync", async () => {
    const agents = [
      { id: "agent:main:main", name: "Main", creature: "cat", active: true },
    ];

    await writeFile(
      orgChartPath,
      makeOrgChartYaml([
        { id: "main", name: "Main", openclawAgentId: "agent:main:main", active: true },
      ]),
    );

    vi.mocked(LiveAdapter).mockImplementation(
      () => ({ getAgents: vi.fn().mockResolvedValue(agents) }) as never,
    );

    const result = await runSyncStep(orgChartPath, true);

    expect(result.imported).toHaveLength(0);
    expect(result.exported).toHaveLength(0);
  });

  it("skips inactive OpenClaw agents during import", async () => {
    await writeFile(orgChartPath, makeOrgChartYaml([]));

    vi.mocked(LiveAdapter).mockImplementation(
      () => ({
        getAgents: vi.fn().mockResolvedValue([
          { id: "agent:main:inactive", name: "Inactive", creature: "cat", active: false },
        ]),
      }) as never,
    );

    const result = await runSyncStep(orgChartPath, true);

    expect(result.imported).toHaveLength(0);
  });

  it("handles export failures gracefully", async () => {
    await writeFile(
      orgChartPath,
      makeOrgChartYaml([
        {
          id: "fail-agent",
          name: "Fail",
          openclawAgentId: "agent:main:fail-agent",
          active: true,
        },
      ]),
    );

    vi.mocked(LiveAdapter).mockImplementation(
      () => ({ getAgents: vi.fn().mockResolvedValue([]) }) as never,
    );

    vi.mocked(openclawConfigSet).mockRejectedValueOnce(new Error("config write failed"));

    // Need agents for export path to trigger
    vi.mocked(LiveAdapter).mockImplementation(
      () => ({
        getAgents: vi.fn().mockResolvedValue([
          { id: "agent:main:other", name: "Other", creature: "cat", active: true },
        ]),
      }) as never,
    );

    const result = await runSyncStep(orgChartPath, true);

    expect(result.warnings.some((w) => w.includes("Failed to register"))).toBe(true);
  });
});
