/**
 * E2E Test Suite 7: Metrics Export
 * 
 * Tests the metrics exporter against real state:
 * - Task creation and metric updates
 * - Context bundle metrics (CTX-002)
 * - Agent footprint metrics (CTX-005)
 * - Prometheus text format output
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { AOFMetrics } from "../../../src/metrics/exporter.js";
import { collectMetrics } from "../../../src/metrics/collector.js";
import { acquireLease } from "../../../src/store/lease.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "metrics-export");

describe("E2E: Metrics Export", () => {
  let store: ITaskStore;
  let metrics: AOFMetrics;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    metrics = new AOFMetrics();
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("task count metrics", () => {
    it("should report tasks by status", async () => {
      // Create tasks in different states
      const task1 = await store.create({
        title: "Backlog Task",
        body: "# Task 1",
        createdBy: "system",
      });

      const task2 = await store.create({
        title: "Ready Task",
        body: "# Task 2",
        createdBy: "system",
      });
      await store.transition(task2.frontmatter.id, "ready");

      const task3 = await store.create({
        title: "In Progress Task",
        body: "# Task 3",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task3.frontmatter.id, "ready");
      await acquireLease(store, task3.frontmatter.id, "agent-1");

      // Collect and update metrics
      const state = await collectMetrics(store);
      metrics.updateFromState(state);

      // Get Prometheus output
      const output = await metrics.getMetrics();

      // Verify metrics present
      expect(output).toContain("aof_tasks_total");
      expect(output).toContain('state="backlog"');
      expect(output).toContain('state="ready"');
      expect(output).toContain('state="in-progress"');
    });

    it("should report tasks by agent and status", async () => {
      // Create tasks for different agents
      const task1 = await store.create({
        title: "Agent 1 Task",
        body: "# Task 1",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task1.frontmatter.id, "ready");
      await acquireLease(store, task1.frontmatter.id, "agent-1");

      const task2 = await store.create({
        title: "Agent 2 Task",
        body: "# Task 2",
        createdBy: "system",
        routing: { agent: "agent-2" },
      });
      await store.transition(task2.frontmatter.id, "ready");
      await acquireLease(store, task2.frontmatter.id, "agent-2");

      // Collect and update metrics
      const state = await collectMetrics(store);
      metrics.updateFromState(state);

      // Get output
      const output = await metrics.getMetrics();

      // Verify agent-specific metrics
      expect(output).toContain('agent="agent-1"');
      expect(output).toContain('agent="agent-2"');
    });
  });

  describe("staleness metrics", () => {
    it("should track task staleness for in-progress tasks", async () => {
      // Create and lease a task
      const task = await store.create({
        title: "Stale Task",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");

      // Wait a bit to create staleness
      await new Promise(resolve => setTimeout(resolve, 100));

      // Collect metrics
      const state = await collectMetrics(store);
      metrics.updateFromState(state);

      const output = await metrics.getMetrics();

      // Verify staleness metric
      expect(output).toContain("aof_task_staleness_seconds");
      expect(output).toContain(`task_id="${task.frontmatter.id}"`);
      expect(output).toContain('agent="test-agent"');
    });
  });

  describe("context bundle metrics (CTX-002)", () => {
    it("should record context bundle size metrics", () => {
      const taskId = "TASK-2025-01-01-001";
      const agentId = "test-agent";
      const contextText = "Sample context bundle with significant content";
      const chars = contextText.length;
      const tokens = Math.ceil(chars / 4); // rough estimate

      metrics.recordContextBundle(taskId, agentId, chars, tokens, "ok");

      // Get metrics output
      const output = metrics.registry.getSingleMetric("aof_context_bundle_chars");
      expect(output).toBeDefined();
    });

    it("should record context budget status", async () => {
      const taskId = "TASK-2025-01-01-002";
      const agentId = "test-agent";

      // Record different budget statuses
      metrics.recordContextBundle(taskId, agentId, 50000, 12500, "ok");
      metrics.recordContextBundle(taskId, agentId, 150000, 37500, "warn");
      metrics.recordContextBundle(taskId, agentId, 250000, 62500, "critical");

      const output = await metrics.getMetrics();

      // Verify budget status counter
      expect(output).toContain("aof_context_budget_status");
      expect(output).toContain('status="ok"');
      expect(output).toContain('status="warn"');
      expect(output).toContain('status="critical"');
    });

    it("should track bundle tokens and chars separately", async () => {
      const taskId = "TASK-2025-01-01-003";
      const agentId = "agent-42";
      const chars = 100000;
      const tokens = 25000;

      metrics.recordContextBundle(taskId, agentId, chars, tokens, "ok");

      const output = await metrics.getMetrics();

      // Both metrics should exist
      expect(output).toContain("aof_context_bundle_chars");
      expect(output).toContain("aof_context_bundle_tokens");
      expect(output).toContain(`taskId="${taskId}"`);
      expect(output).toContain(`agentId="${agentId}"`);
    });
  });

  describe("agent footprint metrics (CTX-005)", () => {
    it("should record agent context bytes", () => {
      const agentId = "agent-alpha";
      const totalChars = 50000;
      const estimatedTokens = 12500;

      metrics.recordAgentFootprint(agentId, totalChars, estimatedTokens);

      const output = metrics.registry.getSingleMetric("aof_agent_context_bytes");
      expect(output).toBeDefined();
    });

    it("should record agent context tokens", async () => {
      const agentId = "agent-beta";
      const totalChars = 75000;
      const estimatedTokens = 18750;

      metrics.recordAgentFootprint(agentId, totalChars, estimatedTokens);

      const output = await metrics.getMetrics();

      expect(output).toContain("aof_agent_context_bytes");
      expect(output).toContain("aof_agent_context_tokens");
      expect(output).toContain(`agentId="${agentId}"`);
    });

    it("should track multiple agents independently", async () => {
      metrics.recordAgentFootprint("agent-1", 40000, 10000);
      metrics.recordAgentFootprint("agent-2", 60000, 15000);
      metrics.recordAgentFootprint("agent-3", 80000, 20000);

      const output = await metrics.getMetrics();

      expect(output).toContain('agentId="agent-1"');
      expect(output).toContain('agentId="agent-2"');
      expect(output).toContain('agentId="agent-3"');
    });
  });

  describe("Prometheus format", () => {
    it("should output valid Prometheus text format", async () => {
      // Create some state
      const task = await store.create({
        title: "Format Test Task",
        body: "# Task",
        createdBy: "system",
      });

      const state = await collectMetrics(store);
      metrics.updateFromState(state);

      const output = await metrics.getMetrics();

      // Basic Prometheus format checks
      expect(output).toContain("# HELP");
      expect(output).toContain("# TYPE");
      expect(output).toContain("aof_tasks_total");
      expect(output).toContain("aof_scheduler_up");
    });

    it("should include default Node.js metrics", async () => {
      const output = await metrics.getMetrics();

      // Check for some default metrics
      expect(output).toContain("aof_nodejs_");
      expect(output).toContain("process_");
    });

    it("should use correct content-type", () => {
      const contentType = metrics.registry.contentType;
      expect(contentType).toMatch(/^text\/plain/);
    });
  });

  describe("scheduler status", () => {
    it("should report scheduler up/down status", async () => {
      const state = await collectMetrics(store);
      state.schedulerUp = true;
      metrics.updateFromState(state);

      const output = await metrics.getMetrics();

      expect(output).toContain("aof_scheduler_up 1");
    });

    it("should record poll duration", async () => {
      metrics.observePollDuration(0.123);
      metrics.observePollDuration(0.456);

      const output = await metrics.getMetrics();

      expect(output).toContain("aof_scheduler_loop_duration_seconds");
    });

    it("should record lock failures", async () => {
      metrics.recordLockFailure();
      metrics.recordLockFailure();

      const output = await metrics.getMetrics();

      expect(output).toContain("aof_lock_acquisition_failures_total");
    });
  });
});
