/**
 * E2E Test Suite 10: Drift Detection
 * 
 * Tests org chart drift detection:
 * - Missing agents (in org chart but not OpenClaw)
 * - Extra agents (in OpenClaw but not org chart)
 * - Agent property mismatches
 * - Permission profile requirements
 * - Both fixture and live adapters
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectDrift } from "../../../src/drift/detector.js";
import type { OrgChart } from "../../../src/schemas/org-chart.js";
import type { OpenClawAgent } from "../../../src/drift/detector.js";
import { FixtureAdapter, LiveAdapter } from "../../../src/drift/adapters.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFile, mkdir } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "drift-detection");

describe("E2E: Drift Detection", () => {
  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("missing agents", () => {
    it("should detect agents in org chart but not in OpenClaw", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
          },
          {
            id: "agent-2",
            name: "Agent Two",
            openclawAgentId: "openclaw-agent-2",
            role: "reviewer",
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
        // openclaw-agent-2 is missing
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.missing).toHaveLength(1);
      expect(report.missing[0].agentId).toBe("agent-2");
      expect(report.missing[0].openclawAgentId).toBe("openclaw-agent-2");
      expect(report.summary.hasDrift).toBe(true);
    });

    it("should ignore agents without openclawAgentId", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            role: "developer",
            // No openclawAgentId — should be skipped
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.missing).toHaveLength(0);
      expect(report.summary.hasDrift).toBe(false);
    });
  });

  describe("extra agents", () => {
    it("should detect agents in OpenClaw but not in org chart", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
        {
          id: "openclaw-agent-extra",
          name: "Extra Agent",
          creature: "dog",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.extra).toHaveLength(1);
      expect(report.extra[0].openclawAgentId).toBe("openclaw-agent-extra");
      expect(report.extra[0].name).toBe("Extra Agent");
      expect(report.summary.hasDrift).toBe(true);
    });

    it("should ignore inactive OpenClaw agents", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-inactive",
          name: "Inactive Agent",
          creature: "bird",
          active: false,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.extra).toHaveLength(0);
      expect(report.summary.hasDrift).toBe(false);
    });
  });

  describe("agent mismatches", () => {
    it("should detect name mismatches between org chart and OpenClaw", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Expected Name",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Different Name",
          creature: "cat",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.mismatch).toHaveLength(1);
      expect(report.mismatch[0].agentId).toBe("agent-1");
      expect(report.mismatch[0].field).toBe("name");
      expect(report.mismatch[0].orgValue).toBe("Expected Name");
      expect(report.mismatch[0].openclawValue).toBe("Different Name");
      expect(report.summary.hasDrift).toBe(true);
    });

    it("should not report mismatch when names match", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Matching Name",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Matching Name",
          creature: "cat",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.mismatch).toHaveLength(0);
      expect(report.summary.hasDrift).toBe(false);
    });
  });

  describe("permission profile requirements", () => {
    it("should detect agents with memory policies needing profiles", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
            policies: {
              memory: {
                canReadAll: false,
                scopes: ["own-tasks"],
              },
            },
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.needsPermissionProfile).toHaveLength(1);
      expect(report.needsPermissionProfile[0].agentId).toBe("agent-1");
      expect(report.needsPermissionProfile[0].reason).toContain("memory policy defined");
      expect(report.summary.hasDrift).toBe(true);
    });

    it("should detect agents with communication policies needing profiles", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
            policies: {
              communication: {
                canInitiate: false,
                allowedChannels: ["internal"],
              },
            },
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.needsPermissionProfile).toHaveLength(1);
      expect(report.needsPermissionProfile[0].reason).toContain("communication policy defined");
    });

    it("should detect agents with tasking policies needing profiles", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
            policies: {
              tasking: {
                canAssign: true,
                canDelegate: false,
              },
            },
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.needsPermissionProfile).toHaveLength(1);
      expect(report.needsPermissionProfile[0].reason).toContain("tasking policy defined");
    });

    it("should detect multiple policy types for same agent", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
            policies: {
              memory: { canReadAll: false, scopes: ["own-tasks"] },
              communication: { canInitiate: false, allowedChannels: ["internal"] },
              tasking: { canAssign: true, canDelegate: false },
            },
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.needsPermissionProfile).toHaveLength(1);
      expect(report.needsPermissionProfile[0].reason).toContain("memory policy defined");
      expect(report.needsPermissionProfile[0].reason).toContain("communication policy defined");
      expect(report.needsPermissionProfile[0].reason).toContain("tasking policy defined");
    });
  });

  describe("comprehensive drift scenarios", () => {
    it("should detect multiple drift types in one scan", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
          },
          {
            id: "agent-2",
            name: "Wrong Name",
            openclawAgentId: "openclaw-agent-2",
            role: "reviewer",
          },
          {
            id: "agent-3",
            name: "Missing Agent",
            openclawAgentId: "openclaw-agent-missing",
            role: "tester",
          },
          {
            id: "agent-4",
            name: "Policy Agent",
            openclawAgentId: "openclaw-agent-4",
            role: "manager",
            policies: {
              memory: { canReadAll: true, scopes: [] },
            },
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
        {
          id: "openclaw-agent-2",
          name: "Correct Name",
          creature: "dog",
          active: true,
        },
        {
          id: "openclaw-agent-4",
          name: "Policy Agent",
          creature: "bird",
          active: true,
        },
        {
          id: "openclaw-extra-agent",
          name: "Extra Agent",
          creature: "fish",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.missing).toHaveLength(1); // agent-3
      expect(report.extra).toHaveLength(1); // openclaw-extra-agent
      expect(report.mismatch).toHaveLength(1); // agent-2 name mismatch
      expect(report.needsPermissionProfile).toHaveLength(1); // agent-4

      expect(report.summary.totalIssues).toBe(4);
      expect(report.summary.hasDrift).toBe(true);
      expect(report.summary.categories.missing).toBe(1);
      expect(report.summary.categories.extra).toBe(1);
      expect(report.summary.categories.mismatch).toBe(1);
      expect(report.summary.categories.needsPermissionProfile).toBe(1);
    });

    it("should report no drift when everything matches", () => {
      const orgChart: OrgChart = {
        version: "1.0",
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            openclawAgentId: "openclaw-agent-1",
            role: "developer",
          },
          {
            id: "agent-2",
            name: "Agent Two",
            openclawAgentId: "openclaw-agent-2",
            role: "reviewer",
          },
        ],
      };

      const openclawAgents: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
        {
          id: "openclaw-agent-2",
          name: "Agent Two",
          creature: "dog",
          active: true,
        },
      ];

      const report = detectDrift(orgChart, openclawAgents);

      expect(report.missing).toHaveLength(0);
      expect(report.extra).toHaveLength(0);
      expect(report.mismatch).toHaveLength(0);
      expect(report.needsPermissionProfile).toHaveLength(0);
      expect(report.summary.totalIssues).toBe(0);
      expect(report.summary.hasDrift).toBe(false);
    });
  });

  describe("fixture adapter", () => {
    it("should load agents from fixture file", async () => {
      // Create fixture file
      const fixturesDir = join(TEST_DATA_DIR, "fixtures");
      await mkdir(fixturesDir, { recursive: true });

      const fixturePath = join(fixturesDir, "agents.json");
      const fixtureData: OpenClawAgent[] = [
        {
          id: "openclaw-agent-1",
          name: "Agent One",
          creature: "cat",
          active: true,
        },
        {
          id: "openclaw-agent-2",
          name: "Agent Two",
          creature: "dog",
          active: true,
        },
      ];

      await writeFile(fixturePath, JSON.stringify(fixtureData, null, 2));

      // Load via adapter
      const adapter = new FixtureAdapter(fixturePath);
      const agents = await adapter.getAgents();

      expect(agents).toHaveLength(2);
      expect(agents[0].id).toBe("openclaw-agent-1");
      expect(agents[1].id).toBe("openclaw-agent-2");
    });

    it("should validate fixture schema — rejects agents missing id", async () => {
      const fixturesDir = join(TEST_DATA_DIR, "fixtures");
      await mkdir(fixturesDir, { recursive: true });

      const fixturePath = join(fixturesDir, "invalid.json");
      // Only id is required; name/creature/active default when absent
      const invalidData = [{ name: "No ID Agent" }]; // missing required id field

      await writeFile(fixturePath, JSON.stringify(invalidData));

      const adapter = new FixtureAdapter(fixturePath);

      await expect(adapter.getAgents()).rejects.toThrow(/Invalid fixture schema/);
    });

    it("should handle missing fixture file", async () => {
      const adapter = new FixtureAdapter("/nonexistent/path.json");

      await expect(adapter.getAgents()).rejects.toThrow(/Failed to load fixture/);
    });
  });

  describe("live adapter", () => {
    it("should call openclaw agents list command", async () => {
      // This test will fail if openclaw is not installed or not in PATH
      // Skip in CI or when openclaw not available
      const adapter = new LiveAdapter();

      try {
        const agents = await adapter.getAgents();
        expect(Array.isArray(agents)).toBe(true);
        // Can't assert exact content since it depends on local environment
      } catch (err) {
        // Expected if openclaw not installed
        expect((err as Error).message).toMatch(/Failed to get live agents/);
      }
    });

    it("should validate live command output", async () => {
      // This is more of a contract test — we can't control the actual output
      // But we can verify the adapter properly validates the schema
      const adapter = new LiveAdapter();

      try {
        const agents = await adapter.getAgents();
        // If it succeeds, verify structure
        for (const agent of agents) {
          expect(agent).toHaveProperty("id");
          expect(agent).toHaveProperty("name");
          expect(agent).toHaveProperty("creature");
          expect(agent).toHaveProperty("active");
        }
      } catch (err) {
        // Expected if openclaw not installed or returns invalid JSON
        expect((err as Error).message).toMatch(/Failed to get live agents/);
      }
    });
  });
});
