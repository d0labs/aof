/**
 * Project Isolation -- End-to-End Integration Test
 *
 * Exercises the full project lifecycle: create project -> create task ->
 * dispatch -> verify task isolation -> verify memory isolation.
 *
 * Covers PROJ-02 through PROJ-06.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { writeFileSync, mkdirSync as mkdirSyncFS } from "node:fs";

describe("Project Isolation -- End-to-End", { timeout: 30_000 }, () => {
  const testDir = join(tmpdir(), `aof-project-e2e-${Date.now()}`);
  const vaultRoot = testDir;

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // --- PROJ-05: Project scaffold ---
  it("creates a project with template structure including memory dir and README", async () => {
    const { createProject } = await import("../../projects/create.js");

    const result = await createProject("test-alpha", {
      vaultRoot,
      title: "Test Alpha Project",
      type: "swe",
      participants: ["agent-a", "agent-b"],
      template: true,
    });

    expect(result.projectId).toBe("test-alpha");
    expect(result.manifest.participants).toEqual(["agent-a", "agent-b"]);
    expect(existsSync(join(result.projectRoot, "tasks"))).toBe(true);
    expect(existsSync(join(result.projectRoot, "memory"))).toBe(true);
    expect(existsSync(join(result.projectRoot, "README.md"))).toBe(true);
    expect(result.directoriesCreated).toContain("memory");

    // Verify README content
    const readme = readFileSync(join(result.projectRoot, "README.md"), "utf-8");
    expect(readme).toContain("Test Alpha Project");
    expect(readme).toContain("agent-a");
    expect(readme).toContain("agent-b");
  });

  it("creates a second project for isolation testing", async () => {
    const { createProject } = await import("../../projects/create.js");

    const result = await createProject("test-beta", {
      vaultRoot,
      title: "Test Beta Project",
      type: "research",
      participants: ["agent-c"],
      template: true,
    });

    expect(result.projectId).toBe("test-beta");
    expect(result.manifest.participants).toEqual(["agent-c"]);
  });

  // --- PROJ-05: Project list ---
  it("discovers both projects via discoverProjects", async () => {
    const { discoverProjects } = await import("../../projects/index.js");
    const projects = await discoverProjects(vaultRoot);

    const ids = projects.map(p => p.id);
    expect(ids).toContain("test-alpha");
    expect(ids).toContain("test-beta");
  });

  // --- PROJ-02: Task creation in project store ---
  it("creates tasks in the correct project directory", async () => {
    const { FilesystemTaskStore } = await import("../../store/task-store.js");

    const alphaRoot = join(vaultRoot, "Projects", "test-alpha");
    const store = new FilesystemTaskStore(alphaRoot, { projectId: "test-alpha" });
    await store.init();

    const task = await store.create({
      title: "Alpha task",
      body: "Should land in test-alpha",
      routing: { agent: "agent-a" },
      createdBy: "test",
    });

    expect(task.frontmatter.id).toBeDefined();
    expect(task.frontmatter.project).toBe("test-alpha");

    // Task should be in the alpha project's tasks directory
    const tasks = await store.list();
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some(t => t.frontmatter.title === "Alpha task")).toBe(true);
  });

  // --- PROJ-03: Participant filtering (allow) ---
  it("dispatcher allows participant agent for project task", async () => {
    const { buildDispatchActions } = await import("../../dispatch/task-dispatcher.js");
    const { FilesystemTaskStore } = await import("../../store/task-store.js");

    const alphaRoot = join(vaultRoot, "Projects", "test-alpha");
    const store = new FilesystemTaskStore(alphaRoot, { projectId: "test-alpha" });
    await store.init();

    // Create a ready task assigned to agent-a (who IS a participant)
    const task = await store.create({
      title: "Dispatch to participant",
      body: "Should succeed",
      routing: { agent: "agent-a" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready", { reason: "test" });

    const readyTasks = await store.list({ status: "ready" });
    const allTasks = await store.list();

    const actions = await buildDispatchActions(
      readyTasks.filter(t => t.frontmatter.title === "Dispatch to participant"),
      allTasks,
      store,
      { dryRun: false, defaultLeaseTtlMs: 30000 },
      {
        currentInProgress: 0,
        blockedBySubtasks: new Set<string>(),
        circularDeps: new Set<string>(),
        occupiedResources: new Map<string, string>(),
        inProgressTasks: [],
      },
      null,
      new Map(),
    );

    // Should have an assign action for agent-a
    const assignActions = actions.filter(a => a.type === "assign");
    expect(assignActions.length).toBeGreaterThanOrEqual(1);
    expect(assignActions.some(a => a.agent === "agent-a")).toBe(true);
  });

  // --- PROJ-03: Participant filtering (block) ---
  it("dispatcher blocks non-participant agent for project task", async () => {
    const { buildDispatchActions } = await import("../../dispatch/task-dispatcher.js");
    const { FilesystemTaskStore } = await import("../../store/task-store.js");

    const alphaRoot = join(vaultRoot, "Projects", "test-alpha");
    const store = new FilesystemTaskStore(alphaRoot, { projectId: "test-alpha" });
    await store.init();

    // Create a ready task assigned to agent-c (who is NOT a participant in alpha)
    const task = await store.create({
      title: "Dispatch to non-participant",
      body: "Should be blocked",
      routing: { agent: "agent-c" },
      createdBy: "test",
    });
    // project field is auto-populated from store.projectId ("test-alpha")
    await store.transition(task.frontmatter.id, "ready", { reason: "test" });

    const readyTasks = await store.list({ status: "ready" });
    const allTasks = await store.list();

    const actions = await buildDispatchActions(
      readyTasks.filter(t => t.frontmatter.title === "Dispatch to non-participant"),
      allTasks,
      store,
      { dryRun: false, defaultLeaseTtlMs: 30000 },
      {
        currentInProgress: 0,
        blockedBySubtasks: new Set<string>(),
        circularDeps: new Set<string>(),
        occupiedResources: new Map<string, string>(),
        inProgressTasks: [],
      },
      null,
      new Map(),
    );

    // Should have an alert (not assign) for agent-c since they are not a participant
    const alertActions = actions.filter(a => a.type === "alert" && a.taskId === task.frontmatter.id);
    expect(alertActions.length).toBe(1);
    expect(alertActions[0].reason).toContain("not a participant");
  });

  // --- PROJ-04: Memory isolation ---
  it("memory search in project A returns nothing from project B", async () => {
    const { getProjectMemoryStore, clearProjectMemoryCache } = await import("../../memory/project-memory.js");

    clearProjectMemoryCache();

    const alphaRoot = join(vaultRoot, "Projects", "test-alpha");
    const betaRoot = join(vaultRoot, "Projects", "test-beta");

    // Use small dimensions for test speed
    const dims = 8;
    const storeA = getProjectMemoryStore(alphaRoot, dims);
    const storeB = getProjectMemoryStore(betaRoot, dims);

    // Store data in project A
    const embedding = [1, 0, 0, 0, 0, 0, 0, 0];
    storeA.vectorStore.insertChunk({
      filePath: "test.md",
      chunkIndex: 0,
      content: "Alpha confidential data",
      embedding,
      pool: "core",
      tier: "hot",
    });

    // Search in project B should find nothing
    const betaResults = storeB.vectorStore.search(embedding, 5);
    expect(betaResults).toHaveLength(0);

    // Search in project A should find the data
    const alphaResults = storeA.vectorStore.search(embedding, 5);
    expect(alphaResults.length).toBeGreaterThanOrEqual(1);
    expect(alphaResults[0].content).toBe("Alpha confidential data");

    clearProjectMemoryCache();
  });
});
