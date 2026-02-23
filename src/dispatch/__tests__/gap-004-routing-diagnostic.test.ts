/**
 * GAP-004: Agent Resolution Diagnostic (Explicit Assignee vs Tag Routing)
 * Date: 2026-02-08 19:34 EST
 * 
 * Diagnostic test to determine if explicit assignee works when tag routing fails.
 * Per remediation plan: if explicit assignee succeeds, tag-only routing is broken.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockExecutor } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("GAP-004: Agent Resolution Diagnostic", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let events: BaseEvent[];
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gap004-test-"));

    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });

    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();

    executor = new MockExecutor();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("GAP-004: task with explicit routing.agent dispatches successfully", async () => {
    // Create task with explicit agent (no tags)
    const task = await store.create({
      title: "Explicit agent test",
      body: "Test with routing.agent",
      routing: { agent: "swe-qa" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Should dispatch successfully
    expect(executor.spawned.length).toBe(1);
    expect(executor.spawned[0]?.context.agent).toBe("swe-qa");

    // Task should be in-progress
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");

    // Poll event should show success
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
    expect(pollEvent?.payload?.actionsFailed).toBe(0);
  });

  it("GAP-004: task with tags only (no explicit agent) behavior", async () => {
    // Create task with tags only, no explicit agent
    const task = await store.create({
      title: "Tags only test",
      body: "Test with routing.tags only",
      routing: { tags: ["backend", "priority"] },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Check if dispatch was attempted
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    
    // Diagnostic output
    console.log("=== GAP-004 DIAGNOSTIC ===");
    console.log(`Task status: ${(await store.get(task.frontmatter.id))?.frontmatter.status}`);
    console.log(`Actions planned: ${pollEvent?.payload?.actionsPlanned}`);
    console.log(`Actions executed: ${pollEvent?.payload?.actionsExecuted}`);
    console.log(`Actions failed: ${pollEvent?.payload?.actionsFailed}`);
    console.log(`Executor spawned: ${executor.spawned.length}`);
    console.log(`Reason: ${pollEvent?.payload?.reason}`);
    console.log("========================");

    // This test documents behavior - tags-only routing may not work
    // If explicit agent works but tags-only doesn't, tag routing is broken
    expect(pollEvent).toBeDefined();
  });

  it("GAP-004: task with routing.role resolves to agent", async () => {
    // Create task with role
    const task = await store.create({
      title: "Role routing test",
      body: "Test with routing.role",
      routing: { role: "qa-engineer" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Check what happened
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    const updatedTask = await store.get(task.frontmatter.id);

    console.log("=== GAP-004 ROLE DIAGNOSTIC ===");
    console.log(`Task status: ${updatedTask?.frontmatter.status}`);
    console.log(`Actions executed: ${pollEvent?.payload?.actionsExecuted}`);
    console.log(`Executor spawned: ${executor.spawned.length}`);
    console.log("==============================");

    // Role should resolve to an agent or fail with error
    expect(pollEvent).toBeDefined();
  });

  it("GAP-004: task with routing.team resolves to agent", async () => {
    // Create task with team
    const task = await store.create({
      title: "Team routing test",
      body: "Test with routing.team",
      routing: { team: "qa-team" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Check what happened
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    const updatedTask = await store.get(task.frontmatter.id);

    console.log("=== GAP-004 TEAM DIAGNOSTIC ===");
    console.log(`Task status: ${updatedTask?.frontmatter.status}`);
    console.log(`Actions executed: ${pollEvent?.payload?.actionsExecuted}`);
    console.log(`Executor spawned: ${executor.spawned.length}`);
    console.log("==============================");

    // Team should resolve to an agent or fail with error
    expect(pollEvent).toBeDefined();
  });

  it("GAP-004: comparison - explicit agent vs tags-only routing", async () => {
    // Create two tasks: one with explicit agent, one with tags only
    const explicitTask = await store.create({
      title: "Explicit agent",
      body: "Has routing.agent",
      routing: { agent: "swe-qa" },
      createdBy: "test",
    });
    await store.transition(explicitTask.frontmatter.id, "ready");

    const tagsTask = await store.create({
      title: "Tags only",
      body: "Has routing.tags only",
      routing: { tags: ["qa", "backend"] },
      createdBy: "test",
    });
    await store.transition(tagsTask.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Compare results
    const explicitUpdated = await store.get(explicitTask.frontmatter.id);
    const tagsUpdated = await store.get(tagsTask.frontmatter.id);
    const pollEvent = events.find(e => e.type === "scheduler.poll");

    console.log("=== GAP-004 COMPARISON ===");
    console.log(`Explicit agent task status: ${explicitUpdated?.frontmatter.status}`);
    console.log(`Tags-only task status: ${tagsUpdated?.frontmatter.status}`);
    console.log(`Total spawned: ${executor.spawned.length}`);
    console.log(`Actions executed: ${pollEvent?.payload?.actionsExecuted}`);
    console.log(`Actions failed: ${pollEvent?.payload?.actionsFailed}`);
    
    // If explicit worked but tags-only didn't, tag routing is broken
    if (explicitUpdated?.frontmatter.status === "in-progress" && 
        tagsUpdated?.frontmatter.status === "ready") {
      console.log("DIAGNOSIS: Explicit agent works, tags-only fails → Tag routing is BROKEN");
    }
    console.log("=========================");

    expect(pollEvent).toBeDefined();
  });

  it("GAP-004: acceptance - explicit assignee must dispatch successfully", async () => {
    // This is the key diagnostic from the remediation plan
    const task = await store.create({
      title: "Acceptance: explicit assignee",
      body: "Task with explicit agent assignment",
      routing: { agent: "swe-qa" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // MUST dispatch successfully per remediation plan
    const updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("in-progress");
    expect(executor.spawned.length).toBe(1);

    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent?.payload?.actionsExecuted).toBe(1);
  });
});
