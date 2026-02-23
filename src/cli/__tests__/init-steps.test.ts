/**
 * Tests for init-steps — Gap #3 (skill wiring) and Gap #4 (qmd dual-indexer).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies before importing the module under test
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
}));

vi.mock("../../packaging/openclaw-cli.js", () => ({
  isAofPluginRegistered: vi.fn(),
  isAofInAllowList: vi.fn(),
  registerAofPlugin: vi.fn(),
  addAofToAllowList: vi.fn(),
  detectMemoryPlugin: vi.fn(),
  configureAofAsMemoryPlugin: vi.fn(),
  isAofMemoryEnabled: vi.fn(),
  isAofMemorySlot: vi.fn(),
  openclawConfigGet: vi.fn(),
  openclawConfigSet: vi.fn(),
}));

// node:fs/promises access is called by runSkillStep; mock to prevent real FS hits
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
}));

import { confirm } from "@inquirer/prompts";
import { openclawConfigGet, openclawConfigSet } from "../../packaging/openclaw-cli.js";
import {
  makeInitialState,
  runSkillWiringStep,
  runQmdStep,
} from "../init-steps.js";

const mockConfirm = vi.mocked(confirm);
const mockConfigGet = vi.mocked(openclawConfigGet);
const mockConfigSet = vi.mocked(openclawConfigSet);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigSet.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Gap #3 — runSkillWiringStep
// ---------------------------------------------------------------------------

describe("runSkillWiringStep", () => {
  it("skips when agents.list is undefined", async () => {
    mockConfigGet.mockResolvedValue(undefined);
    const state = makeInitialState();

    await runSkillWiringStep(state, true);

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state.skillsWired).toBe(false);
    expect(state.skipped).toContain("Skill wiring (no agents configured)");
  });

  it("skips when agents.list is an empty array", async () => {
    mockConfigGet.mockResolvedValue([]);
    const state = makeInitialState();

    await runSkillWiringStep(state, true);

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state.skipped).toContain("Skill wiring (no agents configured)");
  });

  it("skips when all agents already have the aof skill", async () => {
    mockConfigGet.mockResolvedValue([
      { id: "swe-backend", skills: ["serena", "aof"] },
      { id: "swe-qa", skills: ["aof"] },
    ]);
    const state = makeInitialState();

    await runSkillWiringStep(state, true);

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state.skipped).toContain("Skill wiring (already configured)");
  });

  it("wires aof skill to agents missing it (yes=true)", async () => {
    mockConfigGet.mockResolvedValue([
      { id: "swe-backend", skills: ["serena-lsp-guide"] },
      { id: "swe-qa", skills: ["aof"] }, // already has it
      { id: "swe-architect", skills: ["serena-lsp-guide", "self-improving-agent"] },
    ]);
    const state = makeInitialState();

    await runSkillWiringStep(state, true);

    expect(mockConfigSet).toHaveBeenCalledOnce();
    const [path, updated] = mockConfigSet.mock.calls[0] as [string, unknown[]];
    expect(path).toBe("agents.list");
    const list = updated as Array<{ id: string; skills: string[] }>;
    expect(list.find(a => a.id === "swe-backend")?.skills).toContain("aof");
    expect(list.find(a => a.id === "swe-architect")?.skills).toContain("aof");
    // already-wired agent unchanged
    expect(list.find(a => a.id === "swe-qa")?.skills).toEqual(["aof"]);
    expect(state.skillsWired).toBe(true);
  });

  it("creates a skills array for agents that have no skills field", async () => {
    mockConfigGet.mockResolvedValue([{ id: "test-agent" }]);
    const state = makeInitialState();

    await runSkillWiringStep(state, true);

    const [, updated] = mockConfigSet.mock.calls[0] as [string, unknown[]];
    const list = updated as Array<{ id: string; skills: string[] }>;
    expect(list[0]?.skills).toEqual(["aof"]);
    expect(state.skillsWired).toBe(true);
  });

  it("skips when user declines (yes=false)", async () => {
    mockConfigGet.mockResolvedValue([{ id: "swe-backend", skills: ["serena"] }]);
    mockConfirm.mockResolvedValue(false);
    const state = makeInitialState();

    await runSkillWiringStep(state, false);

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state.skillsWired).toBe(false);
    expect(state.skipped).toContain("Skill wiring (user declined)");
  });

  it("adds a warning when configSet throws", async () => {
    mockConfigGet.mockResolvedValue([{ id: "swe-backend", skills: ["serena"] }]);
    mockConfigSet.mockRejectedValue(new Error("Config write failed"));
    const state = makeInitialState();

    await runSkillWiringStep(state, true);

    expect(state.skillsWired).toBe(false);
    expect(state.warnings.some((w) => w.includes("Skill wiring failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap #4 — runQmdStep
// ---------------------------------------------------------------------------

describe("runQmdStep", () => {
  it("no-ops when memory.qmd.update.onBoot is false", async () => {
    mockConfigGet.mockResolvedValue(false);
    const state = makeInitialState();

    await runQmdStep(state, true);

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state.warnings).toHaveLength(0);
  });

  it("no-ops when memory.qmd.update.onBoot is undefined", async () => {
    mockConfigGet.mockResolvedValue(undefined);
    const state = makeInitialState();

    await runQmdStep(state, true);

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state.warnings).toHaveLength(0);
  });

  it("disables qmd boot indexing when enabled and yes=true", async () => {
    mockConfigGet.mockResolvedValue(true);
    const state = makeInitialState();

    await runQmdStep(state, true);

    expect(mockConfigSet).toHaveBeenCalledWith("memory.qmd.update.onBoot", false);
    expect(state.warnings).toHaveLength(0);
  });

  it("adds a warning when user declines to disable qmd", async () => {
    mockConfigGet.mockResolvedValue(true);
    mockConfirm.mockResolvedValue(false);
    const state = makeInitialState();

    await runQmdStep(state, false);

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state.warnings.some((w) => w.includes("qmd boot indexing still enabled"))).toBe(true);
  });

  it("adds a warning when configSet throws", async () => {
    mockConfigGet.mockResolvedValue(true);
    mockConfigSet.mockRejectedValue(new Error("Config write failed"));
    const state = makeInitialState();

    await runQmdStep(state, true);

    expect(state.warnings.some((w) => w.includes("Failed to disable qmd boot indexing"))).toBe(true);
  });
});
