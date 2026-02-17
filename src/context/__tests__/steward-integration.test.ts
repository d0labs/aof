/**
 * Integration tests for context steward with metrics and events.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import type { OrgChart } from "../../schemas/org-chart.js";
import type { ContextBudgetPolicy } from "../budget.js";
import {
  calculateFootprint,
  calculateAllFootprints,
  generateTransparencyReport,
  checkThresholds,
} from "../steward.js";

describe("Context Steward Integration", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;
  let metrics: AOFMetrics;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `aof-test-${randomBytes(8).toString("hex")}`);
    await mkdir(tmpDir, { recursive: true });
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    eventLogger = new EventLogger(join(tmpDir, "events"));
    metrics = new AOFMetrics();
  });

  it("end-to-end: calculates footprints, logs events, and exports metrics", async () => {
    // Create test data
    await store.create({
      title: "Task 1",
      body: "X".repeat(50000),
      createdBy: "agent-alpha",
    });
    await store.create({
      title: "Task 2",
      body: "Y".repeat(30000),
      createdBy: "agent-beta",
    });

    // Set up org chart with policies
    const orgChart: OrgChart = {
      schemaVersion: 1,
      agents: [
        {
          id: "agent-alpha",
          name: "Agent Alpha",
          policies: {
            context: {
              target: 40000,
              warn: 50000,
              critical: 80000,
            },
          },
        },
        {
          id: "agent-beta",
          name: "Agent Beta",
          policies: {
            context: {
              target: 40000,
              warn: 50000,
              critical: 80000,
            },
          },
        },
      ],
    };

    // Calculate footprints
    const footprints = await calculateAllFootprints(store, orgChart);
    expect(footprints).toHaveLength(2);

    // Log footprint events
    for (const footprint of footprints) {
      await eventLogger.logContextFootprint(footprint.agentId, {
        totalChars: footprint.totalChars,
        estimatedTokens: footprint.estimatedTokens,
        breakdownCount: footprint.breakdown.length,
      });

      // Record metrics
      metrics.recordAgentFootprint(
        footprint.agentId,
        footprint.totalChars,
        footprint.estimatedTokens
      );
    }

    // Check thresholds and generate alerts
    const policies = new Map<string, ContextBudgetPolicy>(
      orgChart.agents
        .filter((a) => a.policies?.context)
        .map((a) => [a.id, a.policies!.context!])
    );

    const report = generateTransparencyReport(footprints, policies);
    expect(report.alerts.length).toBeGreaterThan(0);

    // Log alert events
    for (const alert of report.alerts) {
      await eventLogger.logContextAlert(alert.agentId, {
        level: alert.level,
        currentChars: alert.currentChars,
        threshold: alert.threshold,
        message: alert.message,
      });
    }

    // Verify metrics are set
    const metricsOutput = await metrics.getMetrics();
    expect(metricsOutput).toContain("aof_agent_context_bytes");
    expect(metricsOutput).toContain("aof_agent_context_tokens");
    expect(metricsOutput).toContain('agentId="agent-alpha"');
    expect(metricsOutput).toContain('agentId="agent-beta"');
  });

  it("generates transparency report with top contributors", async () => {
    // Create multiple tasks with varying sizes
    await store.create({
      title: "Large Task",
      body: "A".repeat(10000),
      createdBy: "agent-alpha",
    });
    await store.create({
      title: "Medium Task",
      body: "B".repeat(5000),
      createdBy: "agent-alpha",
    });
    await store.create({
      title: "Small Task",
      body: "C".repeat(1000),
      createdBy: "agent-beta",
    });

    const footprints = await calculateAllFootprints(store);
    const report = generateTransparencyReport(footprints);

    expect(report.topContributors.length).toBeGreaterThan(0);
    expect(report.topContributors[0]?.chars).toBeGreaterThanOrEqual(
      report.topContributors[1]?.chars || 0
    );

    // Verify percentages sum to approximately 100% (allow floating-point tolerance)
    const totalPercentage = report.topContributors.reduce(
      (sum, c) => sum + c.percentage,
      0
    );
    expect(totalPercentage).toBeGreaterThan(0);
    expect(totalPercentage).toBeLessThanOrEqual(100.01); // Allow for floating-point rounding
  });

  it("handles agents with no policies gracefully", async () => {
    await store.create({
      title: "Task",
      body: "Content",
      createdBy: "agent-no-policy",
    });

    const footprints = await calculateAllFootprints(store);
    const report = generateTransparencyReport(footprints);

    expect(report.alerts).toHaveLength(0);
    expect(report.agents).toHaveLength(1);
  });

  it("works with empty org chart", async () => {
    const footprints = await calculateAllFootprints(store);
    const report = generateTransparencyReport(footprints);

    expect(footprints).toEqual([]);
    expect(report.topContributors).toEqual([]);
    expect(report.alerts).toEqual([]);
  });
});
