import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore, serializeTask } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import { handleGateTransition } from "../gate-transition-handler.js";
import writeFileAtomic from "write-file-atomic";

describe("Gate Metrics Integration", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let metrics: AOFMetrics;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gate-metrics-test-"));
    store = new FilesystemTaskStore(tmpDir, "test-project");
    await store.init();
    logger = new EventLogger(tmpDir);
    metrics = new AOFMetrics();

    // Create project.yaml with gate workflow
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "project.yaml"),
      `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: swe
  lead: test-lead
workflow:
  name: standard
  gates:
    - id: implement
      role: swe-backend
      canReject: false
    - id: review
      role: swe-qa
      canReject: true
    - id: verify
      role: swe-pm
      canReject: false
`
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records gate duration metric on completion", async () => {
    // Create task at implement gate
    const task = await store.create({
      title: "Test task",
      body: "Task body",
      priority: "normal",
      routing: { role: "swe-backend", workflow: "standard" },
      createdBy: "test",
    });

    // Set gate state
    const loadedTask = await store.get(task.frontmatter.id);
    if (!loadedTask) throw new Error("Task not found");
    loadedTask.frontmatter.gate = {
      current: "implement",
      entered: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    };
    const filePath = loadedTask.path ?? join(tmpDir, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
    await writeFileAtomic(filePath, serializeTask(loadedTask));

    // Complete the gate
    await handleGateTransition(
      store,
      logger,
      task.frontmatter.id,
      "complete",
      { summary: "Implemented" },
      metrics
    );

    // Check metrics
    const output = await metrics.getMetrics();
    
    expect(output).toContain("aof_gate_duration_seconds");
    expect(output).toContain('workflow="standard"');
    expect(output).toContain('gate="implement"');
    expect(output).toContain('outcome="complete"');
    expect(output).toMatch(/aof_gate_duration_seconds_sum.*3600/);
  });

  it("records gate transition metric", async () => {
    const task = await store.create({
      title: "Test task 2",
      body: "Task body",
      priority: "normal",
      routing: { role: "swe-backend", workflow: "standard" },
      createdBy: "test",
    });

    const loadedTask = await store.get(task.frontmatter.id);
    if (!loadedTask) throw new Error("Task not found");
    loadedTask.frontmatter.gate = {
      current: "implement",
      entered: new Date(Date.now() - 1800000).toISOString(), // 30 min ago
    };
    const filePath = loadedTask.path ?? join(tmpDir, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
    await writeFileAtomic(filePath, serializeTask(loadedTask));

    await handleGateTransition(
      store,
      logger,
      task.frontmatter.id,
      "complete",
      { summary: "Done" },
      metrics
    );

    const output = await metrics.getMetrics();
    
    expect(output).toContain("aof_gate_transitions_total");
    expect(output).toContain('from_gate="implement"');
    expect(output).toContain('to_gate="review"');
  });

  it("records gate rejection metric on needs_review", async () => {
    const task = await store.create({
      title: "Test task 3",
      body: "Task body",
      priority: "normal",
      routing: { role: "swe-qa", workflow: "standard" },
      createdBy: "test",
    });

    const loadedTask = await store.get(task.frontmatter.id);
    if (!loadedTask) throw new Error("Task not found");
    loadedTask.frontmatter.gate = {
      current: "review",
      entered: new Date(Date.now() - 900000).toISOString(), // 15 min ago
    };
    const filePath = loadedTask.path ?? join(tmpDir, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
    await writeFileAtomic(filePath, serializeTask(loadedTask));

    await handleGateTransition(
      store,
      logger,
      task.frontmatter.id,
      "needs_review",
      { 
        summary: "Needs changes",
        rejectionNotes: "Code quality issues"
      },
      metrics
    );

    const output = await metrics.getMetrics();
    
    expect(output).toContain("aof_gate_rejections_total");
    expect(output).toContain('gate="review"');
    expect(output).toContain('workflow="standard"');
  });

  it("works without metrics (backward compatible)", async () => {
    const task = await store.create({
      title: "Test task 4",
      body: "Task body",
      priority: "normal",
      routing: { role: "swe-backend", workflow: "standard" },
      createdBy: "test",
    });

    const loadedTask = await store.get(task.frontmatter.id);
    if (!loadedTask) throw new Error("Task not found");
    loadedTask.frontmatter.gate = {
      current: "implement",
      entered: new Date().toISOString(),
    };
    const filePath = loadedTask.path ?? join(tmpDir, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
    await writeFileAtomic(filePath, serializeTask(loadedTask));

    // Should not throw when metrics is undefined
    await expect(
      handleGateTransition(
        store,
        logger,
        task.frontmatter.id,
        "complete",
        { summary: "Done" }
        // No metrics parameter
      )
    ).resolves.toBeDefined();
  });
});
