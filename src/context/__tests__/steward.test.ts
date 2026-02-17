/**
 * Tests for context steward — footprint tracking and threshold alerts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { OrgChart } from "../../schemas/org-chart.js";
import type { ContextBudgetPolicy } from "../budget.js";
import {
  calculateFootprint,
  calculateAllFootprints,
  generateTransparencyReport,
  checkThresholds,
  type AgentFootprint,
  type TransparencyReport,
  type FootprintAlert,
} from "../steward.js";

describe("Context Steward", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tmpDir = join(tmpdir(), `aof-test-${randomBytes(8).toString("hex")}`);
    await mkdir(tmpDir, { recursive: true });
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  describe("calculateFootprint()", () => {
    it("returns zero footprint for agent with no tasks", async () => {
      const footprint = await calculateFootprint("agent-alpha", store);

      expect(footprint).toEqual({
        agentId: "agent-alpha",
        totalChars: 0,
        estimatedTokens: 0,
        breakdown: [],
      });
    });

    it("calculates footprint from task file (body + frontmatter)", async () => {
      const task = await store.create({
        title: "Test Task",
        body: "# Instructions\n\nSome task instructions here.",
        createdBy: "agent-alpha",
      });

      const footprint = await calculateFootprint("agent-alpha", store);

      expect(footprint.agentId).toBe("agent-alpha");
      expect(footprint.totalChars).toBeGreaterThan(0);
      expect(footprint.estimatedTokens).toBeGreaterThan(0);
      expect(footprint.breakdown).toHaveLength(1);
      expect(footprint.breakdown[0]?.kind).toBe("task");
      expect(footprint.breakdown[0]?.path).toContain(task.frontmatter.id);
    });

    it("includes input files when present", async () => {
      const task = await store.create({
        title: "Task with inputs",
        body: "Process the input files.",
        createdBy: "agent-beta",
      });

      // Write some input files
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "input1.txt"), "Input content 1");
      await writeFile(join(inputsDir, "input2.md"), "Input content 2");

      const footprint = await calculateFootprint("agent-beta", store);

      expect(footprint.totalChars).toBeGreaterThan(0);
      const inputBreakdown = footprint.breakdown.filter((b) => b.kind === "input");
      expect(inputBreakdown).toHaveLength(2);
    });

    it("excludes output files by default", async () => {
      const task = await store.create({
        title: "Task with outputs",
        body: "Generate outputs.",
        createdBy: "agent-gamma",
      });

      // Write some output files
      const outputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "outputs");
      await mkdir(outputsDir, { recursive: true });
      await writeFile(join(outputsDir, "result.txt"), "Output content");

      const footprint = await calculateFootprint("agent-gamma", store);

      const outputBreakdown = footprint.breakdown.filter((b) => b.kind === "output");
      expect(outputBreakdown).toHaveLength(0);
    });

    it("includes output files when includeOutputs option is true", async () => {
      const task = await store.create({
        title: "Task with outputs",
        body: "Generate outputs.",
        createdBy: "agent-delta",
      });

      // Write some output files
      const outputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "outputs");
      await mkdir(outputsDir, { recursive: true });
      await writeFile(join(outputsDir, "result.txt"), "Output content");

      const footprint = await calculateFootprint("agent-delta", store, {
        includeOutputs: true,
      });

      const outputBreakdown = footprint.breakdown.filter((b) => b.kind === "output");
      expect(outputBreakdown).toHaveLength(1);
      expect(outputBreakdown[0]?.chars).toBeGreaterThan(0);
    });

    it("estimates tokens using 4-chars-per-token heuristic", async () => {
      await store.create({
        title: "Test",
        body: "A".repeat(400), // 400 chars = 100 tokens
        createdBy: "agent-epsilon",
      });

      const footprint = await calculateFootprint("agent-epsilon", store);

      // Should be approximately 100 tokens (400 chars / 4) but includes frontmatter overhead
      expect(footprint.estimatedTokens).toBeGreaterThanOrEqual(100);
      expect(footprint.estimatedTokens).toBeLessThanOrEqual(200); // Allow overhead for frontmatter
    });

    it("aggregates footprint across multiple tasks", async () => {
      await store.create({
        title: "Task 1",
        body: "First task",
        createdBy: "agent-multi",
      });
      await store.create({
        title: "Task 2",
        body: "Second task",
        createdBy: "agent-multi",
      });

      const footprint = await calculateFootprint("agent-multi", store);

      expect(footprint.breakdown.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("calculateAllFootprints()", () => {
    it("returns empty array when no tasks exist", async () => {
      const footprints = await calculateAllFootprints(store);

      expect(footprints).toEqual([]);
    });

    it("calculates footprints for all agents with tasks", async () => {
      await store.create({
        title: "Task A",
        body: "Task for agent A",
        createdBy: "agent-a",
      });
      await store.create({
        title: "Task B",
        body: "Task for agent B",
        createdBy: "agent-b",
      });
      await store.create({
        title: "Task C",
        body: "Task for agent A again",
        createdBy: "agent-a",
      });

      const footprints = await calculateAllFootprints(store);

      expect(footprints).toHaveLength(2);
      expect(footprints.find((f) => f.agentId === "agent-a")).toBeDefined();
      expect(footprints.find((f) => f.agentId === "agent-b")).toBeDefined();
    });

    it("uses org chart to include agents with zero footprint", async () => {
      await store.create({
        title: "Task A",
        body: "Task",
        createdBy: "agent-a",
      });

      const orgChart: OrgChart = {
        schemaVersion: 1,
        agents: [
          { id: "agent-a", name: "Agent A" },
          { id: "agent-b", name: "Agent B" },
          { id: "agent-c", name: "Agent C" },
        ],
      };

      const footprints = await calculateAllFootprints(store, orgChart);

      expect(footprints).toHaveLength(3);
      expect(footprints.find((f) => f.agentId === "agent-a")?.totalChars).toBeGreaterThan(0);
      expect(footprints.find((f) => f.agentId === "agent-b")?.totalChars).toBe(0);
      expect(footprints.find((f) => f.agentId === "agent-c")?.totalChars).toBe(0);
    });
  });

  describe("generateTransparencyReport()", () => {
    it("generates report with timestamp and footprints", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-1",
          totalChars: 1000,
          estimatedTokens: 250,
          breakdown: [
            { path: "tasks/backlog/TASK-001.md", chars: 1000, kind: "task" },
          ],
        },
      ];

      const report = generateTransparencyReport(footprints);

      expect(report.timestamp).toBeDefined();
      expect(new Date(report.timestamp).getTime()).toBeGreaterThan(0);
      expect(report.agents).toEqual(footprints);
      expect(report.topContributors).toHaveLength(1);
      expect(report.alerts).toHaveLength(0);
    });

    it("identifies top contributors by character count", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-1",
          totalChars: 5000,
          estimatedTokens: 1250,
          breakdown: [
            { path: "tasks/backlog/TASK-001.md", chars: 3000, kind: "task" },
            { path: "tasks/backlog/TASK-001/inputs/large.txt", chars: 2000, kind: "input" },
          ],
        },
        {
          agentId: "agent-2",
          totalChars: 1000,
          estimatedTokens: 250,
          breakdown: [
            { path: "tasks/backlog/TASK-002.md", chars: 1000, kind: "task" },
          ],
        },
      ];

      const report = generateTransparencyReport(footprints);

      expect(report.topContributors).toHaveLength(3);
      // Largest first
      expect(report.topContributors[0]?.path).toBe("tasks/backlog/TASK-001.md");
      expect(report.topContributors[0]?.chars).toBe(3000);
      expect(report.topContributors[1]?.path).toBe("tasks/backlog/TASK-001/inputs/large.txt");
      expect(report.topContributors[1]?.chars).toBe(2000);
    });

    it("calculates contributor percentages correctly", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-1",
          totalChars: 8000,
          estimatedTokens: 2000,
          breakdown: [
            { path: "task1.md", chars: 4000, kind: "task" },
            { path: "task2.md", chars: 4000, kind: "task" },
          ],
        },
        {
          agentId: "agent-2",
          totalChars: 2000,
          estimatedTokens: 500,
          breakdown: [
            { path: "task3.md", chars: 2000, kind: "task" },
          ],
        },
      ];

      const report = generateTransparencyReport(footprints);

      // Total is 10000 chars
      expect(report.topContributors[0]?.percentage).toBeCloseTo(40.0, 1); // 4000/10000
      expect(report.topContributors[1]?.percentage).toBeCloseTo(40.0, 1); // 4000/10000
      expect(report.topContributors[2]?.percentage).toBeCloseTo(20.0, 1); // 2000/10000
    });

    it("limits top contributors to 10 items", () => {
      const breakdown = Array.from({ length: 15 }, (_, i) => ({
        path: `task-${i}.md`,
        chars: 100 * (15 - i), // Descending sizes
        kind: "task" as const,
      }));

      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-prolific",
          totalChars: breakdown.reduce((sum, b) => sum + b.chars, 0),
          estimatedTokens: 3000,
          breakdown,
        },
      ];

      const report = generateTransparencyReport(footprints);

      expect(report.topContributors).toHaveLength(10);
    });

    it("generates alerts when no policies provided", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-1",
          totalChars: 100000,
          estimatedTokens: 25000,
          breakdown: [],
        },
      ];

      const report = generateTransparencyReport(footprints);

      expect(report.alerts).toHaveLength(0);
    });

    it("generates alerts based on policies", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-warn",
          totalChars: 60000,
          estimatedTokens: 15000,
          breakdown: [],
        },
        {
          agentId: "agent-critical",
          totalChars: 90000,
          estimatedTokens: 22500,
          breakdown: [],
        },
        {
          agentId: "agent-ok",
          totalChars: 30000,
          estimatedTokens: 7500,
          breakdown: [],
        },
      ];

      const policies = new Map<string, ContextBudgetPolicy>([
        ["agent-warn", { target: 40000, warn: 50000, critical: 80000 }],
        ["agent-critical", { target: 40000, warn: 50000, critical: 80000 }],
        ["agent-ok", { target: 40000, warn: 50000, critical: 80000 }],
      ]);

      const report = generateTransparencyReport(footprints, policies);

      expect(report.alerts).toHaveLength(2);
      const warnAlert = report.alerts.find((a) => a.agentId === "agent-warn");
      const criticalAlert = report.alerts.find((a) => a.agentId === "agent-critical");

      expect(warnAlert?.level).toBe("warn");
      expect(criticalAlert?.level).toBe("critical");
    });
  });

  describe("checkThresholds()", () => {
    it("returns empty array when no policies provided", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-1",
          totalChars: 100000,
          estimatedTokens: 25000,
          breakdown: [],
        },
      ];

      const alerts = checkThresholds(footprints, new Map());

      expect(alerts).toHaveLength(0);
    });

    it("returns empty array when all agents within budget", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-1",
          totalChars: 30000,
          estimatedTokens: 7500,
          breakdown: [],
        },
        {
          agentId: "agent-2",
          totalChars: 25000,
          estimatedTokens: 6250,
          breakdown: [],
        },
      ];

      const policies = new Map<string, ContextBudgetPolicy>([
        ["agent-1", { target: 40000, warn: 50000, critical: 80000 }],
        ["agent-2", { target: 40000, warn: 50000, critical: 80000 }],
      ]);

      const alerts = checkThresholds(footprints, policies);

      expect(alerts).toHaveLength(0);
    });

    it("generates warn-level alert when exceeding warn threshold", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-warn",
          totalChars: 55000,
          estimatedTokens: 13750,
          breakdown: [],
        },
      ];

      const policies = new Map<string, ContextBudgetPolicy>([
        ["agent-warn", { target: 40000, warn: 50000, critical: 80000 }],
      ]);

      const alerts = checkThresholds(footprints, policies);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toEqual({
        agentId: "agent-warn",
        level: "warn",
        currentChars: 55000,
        threshold: 50000,
        message: expect.stringContaining("exceeds warn threshold"),
      });
    });

    it("generates critical-level alert when exceeding critical threshold", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-critical",
          totalChars: 85000,
          estimatedTokens: 21250,
          breakdown: [],
        },
      ];

      const policies = new Map<string, ContextBudgetPolicy>([
        ["agent-critical", { target: 40000, warn: 50000, critical: 80000 }],
      ]);

      const alerts = checkThresholds(footprints, policies);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toEqual({
        agentId: "agent-critical",
        level: "critical",
        currentChars: 85000,
        threshold: 80000,
        message: expect.stringContaining("exceeds critical threshold"),
      });
    });

    it("generates multiple alerts for multiple agents", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-1",
          totalChars: 55000,
          estimatedTokens: 13750,
          breakdown: [],
        },
        {
          agentId: "agent-2",
          totalChars: 85000,
          estimatedTokens: 21250,
          breakdown: [],
        },
        {
          agentId: "agent-3",
          totalChars: 30000,
          estimatedTokens: 7500,
          breakdown: [],
        },
      ];

      const policies = new Map<string, ContextBudgetPolicy>([
        ["agent-1", { target: 40000, warn: 50000, critical: 80000 }],
        ["agent-2", { target: 40000, warn: 50000, critical: 80000 }],
        ["agent-3", { target: 40000, warn: 50000, critical: 80000 }],
      ]);

      const alerts = checkThresholds(footprints, policies);

      expect(alerts).toHaveLength(2);
    });

    it("ignores agents without policies", () => {
      const footprints: AgentFootprint[] = [
        {
          agentId: "agent-no-policy",
          totalChars: 100000,
          estimatedTokens: 25000,
          breakdown: [],
        },
        {
          agentId: "agent-with-policy",
          totalChars: 55000,
          estimatedTokens: 13750,
          breakdown: [],
        },
      ];

      const policies = new Map<string, ContextBudgetPolicy>([
        ["agent-with-policy", { target: 40000, warn: 50000, critical: 80000 }],
      ]);

      const alerts = checkThresholds(footprints, policies);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.agentId).toBe("agent-with-policy");
    });
  });
});
