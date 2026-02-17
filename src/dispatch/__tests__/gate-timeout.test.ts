import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore, serializeTask } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import writeFileAtomic from "write-file-atomic";
import { parseDuration } from "../duration-parser.js";

describe("Duration Parser", () => {
  it("parses minutes correctly", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
    expect(parseDuration("1m")).toBe(60 * 1000);
    expect(parseDuration("90m")).toBe(90 * 60 * 1000);
  });

  it("parses hours correctly", () => {
    expect(parseDuration("1h")).toBe(60 * 60 * 1000);
    expect(parseDuration("2h")).toBe(2 * 60 * 60 * 1000);
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("999h")).toBe(999 * 60 * 60 * 1000);
  });

  it("returns null for invalid formats", () => {
    expect(parseDuration("")).toBe(null);
    expect(parseDuration("1")).toBe(null);
    expect(parseDuration("1s")).toBe(null);
    expect(parseDuration("1d")).toBe(null);
    expect(parseDuration("abc")).toBe(null);
    expect(parseDuration("1hm")).toBe(null);
    expect(parseDuration("m1")).toBe(null);
    expect(parseDuration("1.5h")).toBe(null);
    expect(parseDuration("0.5m")).toBe(null);
  });

  it("returns null for negative values", () => {
    expect(parseDuration("-1h")).toBe(null);
    expect(parseDuration("-30m")).toBe(null);
  });

  it("returns null for zero values", () => {
    expect(parseDuration("0m")).toBe(null);
    expect(parseDuration("0h")).toBe(null);
  });
});

describe("Gate Timeout Detection", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-gate-timeout-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const config = {
    dataDir: "",
    dryRun: false,
    defaultLeaseTtlMs: 600_000,
  };

  it("detects timeout and escalates to configured role", async () => {
    // Create project manifest with workflow
    const projectYaml = `
name: test-project
workflow:
  name: default
  rejectionStrategy: origin
  gates:
    - id: review
      role: swe-qa
      timeout: "1h"
      escalateTo: swe-pm
`;
    const projectDir = join(tmpDir, "projects", "test-project");
    await mkdir(projectDir, { recursive: true });
    await writeFileAtomic(join(projectDir, "project.yaml"), projectYaml);

    // Create task in-progress with expired gate timeout
    const task = await store.create({
      title: "Test task",
      createdBy: "main",
      routing: { role: "swe-qa" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    // Update task with gate field after transitions
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      taskData.frontmatter.project = "test-project";
      taskData.frontmatter.gate = {
        current: "review",
        entered: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      };
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    // Poll should detect timeout
    const result = await poll(store, logger, config);

    // Check for alert action
    const alerts = result.actions.filter((a) => a.type === "alert");
    expect(alerts.length).toBeGreaterThan(0);
    
    const timeoutAlert = alerts.find(
      (a) => a.reason?.includes("timeout") && a.reason?.includes("escalated")
    );
    expect(timeoutAlert).toBeDefined();
    expect(timeoutAlert?.agent).toBe("swe-pm");

    // Verify task was re-routed
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.routing.role).toBe("swe-pm");
    
    // Verify gate history was updated
    expect(updatedTask?.frontmatter.gateHistory).toBeDefined();
    expect(updatedTask?.frontmatter.gateHistory?.length).toBeGreaterThan(0);
    const historyEntry = updatedTask?.frontmatter.gateHistory?.[0];
    expect(historyEntry?.outcome).toBe("blocked");
    expect(historyEntry?.summary).toContain("Timeout");
  });

  it("logs warning when timeout occurs without escalateTo", async () => {
    // Create project manifest with workflow (no escalateTo)
    const projectYaml = `
name: test-project
workflow:
  name: default
  rejectionStrategy: origin
  gates:
    - id: review
      role: swe-qa
      timeout: "1h"
`;
    const projectDir = join(tmpDir, "projects", "test-project");
    await mkdir(projectDir, { recursive: true });
    await writeFileAtomic(join(projectDir, "project.yaml"), projectYaml);

    // Create task in-progress with expired gate timeout
    const task = await store.create({
      title: "Test task",
      createdBy: "main",
      routing: { role: "swe-qa" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    // Update task with gate field after transitions
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      taskData.frontmatter.project = "test-project";
      taskData.frontmatter.gate = {
        current: "review",
        entered: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      };
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    // Poll should detect timeout
    const result = await poll(store, logger, config);

    // Should have alert for timeout without escalation
    const alerts = result.actions.filter((a) => a.type === "alert");
    const timeoutAlert = alerts.find((a) => a.reason?.includes("timeout"));
    expect(timeoutAlert).toBeDefined();
    expect(timeoutAlert?.reason).toContain("no escalation");
  });

  it("ignores tasks without gate", async () => {
    // Create task without gate
    const task = await store.create({
      title: "Non-gate task",
      createdBy: "main",
      routing: { role: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");

    const result = await poll(store, logger, config);

    // Should not have any timeout-related actions
    const timeoutAlerts = result.actions.filter(
      (a) => a.reason?.includes("timeout")
    );
    expect(timeoutAlerts).toHaveLength(0);
  });

  it("ignores tasks within timeout window", async () => {
    // Create project manifest with workflow
    const projectYaml = `
name: test-project
workflow:
  name: default
  rejectionStrategy: origin
  gates:
    - id: review
      role: swe-qa
      timeout: "1h"
      escalateTo: swe-pm
`;
    const projectDir = join(tmpDir, "projects", "test-project");
    await mkdir(projectDir, { recursive: true });
    await writeFileAtomic(join(projectDir, "project.yaml"), projectYaml);

    // Create task with recent gate entry (30 min ago)
    const task = await store.create({
      title: "Test task",
      createdBy: "main",
      routing: { role: "swe-qa" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    // Update task with gate field after transitions
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      taskData.frontmatter.project = "test-project";
      taskData.frontmatter.gate = {
        current: "review",
        entered: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      };
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    const result = await poll(store, logger, config);

    // Should not have timeout alerts
    const timeoutAlerts = result.actions.filter(
      (a) => a.reason?.includes("timeout")
    );
    expect(timeoutAlerts).toHaveLength(0);
  });

  it("handles invalid timeout format gracefully", async () => {
    // Create project manifest with invalid timeout
    const projectYaml = `
name: test-project
workflow:
  name: default
  rejectionStrategy: origin
  gates:
    - id: review
      role: swe-qa
      timeout: "invalid"
`;
    const projectDir = join(tmpDir, "projects", "test-project");
    await mkdir(projectDir, { recursive: true });
    await writeFileAtomic(join(projectDir, "project.yaml"), projectYaml);

    // Create task in-progress
    const task = await store.create({
      title: "Test task",
      createdBy: "main",
      routing: { role: "swe-qa" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    // Update task with gate field after transitions
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      taskData.frontmatter.project = "test-project";
      taskData.frontmatter.gate = {
        current: "review",
        entered: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      };
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    // Should not throw, just skip the task
    await expect(poll(store, logger, config)).resolves.toBeDefined();
  });
});
