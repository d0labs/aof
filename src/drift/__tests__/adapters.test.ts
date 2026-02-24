/**
 * Drift Adapter Tests — Fixture and Live sources
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FixtureAdapter, LiveAdapter } from "../adapters.js";

describe("FixtureAdapter", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "aof-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads agents from JSON fixture file", async () => {
    const fixturePath = join(tempDir, "agents.json");
    const fixtureData = [
      { id: "agent:main:main", name: "Main", creature: "agent", active: true },
      { id: "agent:dev:main", name: "Dev", creature: "agent", active: true },
    ];
    writeFileSync(fixturePath, JSON.stringify(fixtureData, null, 2));

    const adapter = new FixtureAdapter(fixturePath);
    const agents = await adapter.getAgents();

    expect(agents).toHaveLength(2);
    expect(agents[0]?.id).toBe("agent:main:main");
    expect(agents[1]?.id).toBe("agent:dev:main");
  });

  it("throws error if fixture file does not exist", async () => {
    const adapter = new FixtureAdapter(join(tempDir, "nonexistent.json"));
    
    await expect(adapter.getAgents()).rejects.toThrow();
  });

  it("throws error if fixture file is invalid JSON", async () => {
    const fixturePath = join(tempDir, "invalid.json");
    writeFileSync(fixturePath, "not valid json");

    const adapter = new FixtureAdapter(fixturePath);
    
    await expect(adapter.getAgents()).rejects.toThrow();
  });

  it("validates agent schema — accepts partial agents with defaults", async () => {
    const fixturePath = join(tempDir, "partial-schema.json");
    // name/creature/active are optional; only id is required
    const fixtureData = [
      { id: "agent:main:main" },
    ];
    writeFileSync(fixturePath, JSON.stringify(fixtureData, null, 2));

    const adapter = new FixtureAdapter(fixturePath);
    const agents = await adapter.getAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("agent:main:main");
    expect(agents[0].name).toBe("Unknown");
    expect(agents[0].active).toBe(true);
  });

  it("rejects agents missing id field", async () => {
    const fixturePath = join(tempDir, "missing-id.json");
    const fixtureData = [
      { name: "No ID Agent" }, // Missing id — truly invalid
    ];
    writeFileSync(fixturePath, JSON.stringify(fixtureData, null, 2));

    const adapter = new FixtureAdapter(fixturePath);
    await expect(adapter.getAgents()).rejects.toThrow();
  });
});

describe("LiveAdapter", () => {
  it("has getAgents method", () => {
    const adapter = new LiveAdapter();
    
    expect(adapter.getAgents).toBeDefined();
    expect(typeof adapter.getAgents).toBe("function");
  });

  it("throws error when openclaw command fails", async () => {
    const adapter = new LiveAdapter();
    
    // Command will fail if openclaw not installed or returns invalid JSON
    // We expect this to throw in test environment
    await expect(adapter.getAgents()).rejects.toThrow(/Failed to get live agents/);
  });
});
