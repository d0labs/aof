/**
 * Tests for project-scoped CLI commands.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { createProjectStore } from "../project-utils.js";

describe("CLI project-scoped commands", () => {
  let tmpDir: string;
  let inboxDir: string;
  let testProjectDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-cli-project-commands-"));
    
    // Create _inbox project
    inboxDir = join(tmpDir, "Projects", "_inbox");
    await mkdir(join(inboxDir, "tasks", "backlog"), { recursive: true });
    await mkdir(join(inboxDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(inboxDir, "tasks", "done"), { recursive: true });
    await mkdir(join(inboxDir, "events"), { recursive: true });
    
    // Create test-project
    testProjectDir = join(tmpDir, "Projects", "test-project");
    await mkdir(join(testProjectDir, "tasks", "backlog"), { recursive: true });
    await mkdir(join(testProjectDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testProjectDir, "tasks", "done"), { recursive: true });
    await mkdir(join(testProjectDir, "events"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("runbook check with --project", () => {
    it("resolves task from specified project", async () => {
      const { store: testStore } = await createProjectStore({
        projectId: "test-project",
        vaultRoot: tmpDir,
      });

      await testStore.init();
      
      // Create task in test-project
      const task = await testStore.create({
        title: "Test task for runbook check",
        priority: "normal",
        routing: { team: "eng" },
        createdBy: "test",
      });

      // Verify task is in test-project and can be resolved
      const resolved = await testStore.getByPrefix(task.frontmatter.id);
      expect(resolved).toBeDefined();
      expect(resolved?.frontmatter.id).toBe(task.frontmatter.id);
      expect(resolved?.frontmatter.title).toBe("Test task for runbook check");
      
      // Verify it's using the project-scoped store
      expect(testStore.projectId).toBe("test-project");
    });

    it("does not find task from other project", async () => {
      // Create task in _inbox
      const { store: inboxStore } = await createProjectStore({
        projectId: "_inbox",
        vaultRoot: tmpDir,
      });
      await inboxStore.init();
      const inboxTask = await inboxStore.create({
        title: "Inbox task",
        priority: "normal",
        routing: { team: "eng" },
        createdBy: "test",
      });

      // Try to resolve from test-project
      const { store: testStore } = await createProjectStore({
        projectId: "test-project",
        vaultRoot: tmpDir,
      });
      await testStore.init();
      
      const resolved = await testStore.getByPrefix(inboxTask.frontmatter.id);
      expect(resolved).toBeUndefined();
    });
  });

  describe("task list with --project", () => {
    it("lists tasks from specified project only", async () => {
      // Create tasks in _inbox
      const { store: inboxStore } = await createProjectStore({
        projectId: "_inbox",
        vaultRoot: tmpDir,
      });
      await inboxStore.init();
      
      await inboxStore.create({
        title: "Inbox task 1",
        priority: "normal",
        routing: { team: "eng" },
        createdBy: "test",
      });
      
      await inboxStore.create({
        title: "Inbox task 2",
        priority: "high",
        routing: { team: "eng" },
        createdBy: "test",
      });

      // Create tasks in test-project
      const { store: testStore } = await createProjectStore({
        projectId: "test-project",
        vaultRoot: tmpDir,
      });
      await testStore.init();
      
      await testStore.create({
        title: "Test project task 1",
        priority: "normal",
        routing: { team: "eng" },
        createdBy: "test",
      });

      // List from _inbox
      const inboxTasks = await inboxStore.list();
      expect(inboxTasks).toHaveLength(2);
      expect(inboxTasks.every(t => t.frontmatter.title.includes("Inbox"))).toBe(true);

      // List from test-project
      const testTasks = await testStore.list();
      expect(testTasks).toHaveLength(1);
      expect(testTasks[0]?.frontmatter.title).toBe("Test project task 1");
    });
  });

  describe("view paths under project root", () => {
    it("generates mailbox views under project views directory", async () => {
      const { store, projectRoot } = await createProjectStore({
        projectId: "test-project",
        vaultRoot: tmpDir,
      });
      await store.init();

      // Create task assigned to agent in ready status (maps to inbox mailbox)
      const task = await store.create({
        title: "Task for agent",
        priority: "normal",
        routing: { agent: "test-agent", team: "eng" },
        createdBy: "test",
      });
      
      // Transition to ready status so it appears in mailbox
      await store.transition(task.frontmatter.id, "ready", "Test transition");

      // Sync mailbox view
      const { syncMailboxView } = await import("../../views/mailbox.js");
      const result = await syncMailboxView(store, {
        dataDir: projectRoot,
      });

      expect(result.agents).toContain("test-agent");
      expect(result.pointerCount).toBeGreaterThan(0);

      // Verify view path is under project root
      const expectedViewPath = join(projectRoot, "views", "mailbox", "test-agent", "inbox");
      const { access } = await import("node:fs/promises");
      await expect(access(expectedViewPath)).resolves.toBeUndefined();
    });

    it("generates kanban views under project views directory", async () => {
      const { store, projectRoot } = await createProjectStore({
        projectId: "test-project",
        vaultRoot: tmpDir,
      });
      await store.init();

      // Create tasks
      await store.create({
        title: "High priority task",
        priority: "high",
        routing: { team: "eng" },
        createdBy: "test",
      });

      await store.create({
        title: "Normal priority task",
        priority: "normal",
        routing: { team: "eng" },
        createdBy: "test",
      });

      // Sync kanban view
      const { syncKanbanView } = await import("../../views/kanban.js");
      const result = await syncKanbanView(store, {
        dataDir: projectRoot,
        swimlaneBy: "priority",
      });

      expect(result.swimlanes).toContain("high");
      expect(result.swimlanes).toContain("normal");
      expect(result.pointerCount).toBeGreaterThan(0);

      // Verify view paths are under project root
      const { access } = await import("node:fs/promises");
      const expectedHighPath = join(projectRoot, "views", "kanban", "priority", "high", "backlog");
      const expectedNormalPath = join(projectRoot, "views", "kanban", "priority", "normal", "backlog");
      
      await expect(access(expectedHighPath)).resolves.toBeUndefined();
      await expect(access(expectedNormalPath)).resolves.toBeUndefined();
    });
  });

  describe("MCP context project awareness", () => {
    it("creates project-scoped context when projectId provided", async () => {
      const { createAofMcpContext } = await import("../../mcp/shared.js");
      
      const ctx = await createAofMcpContext({
        dataDir: tmpDir,
        projectId: "test-project",
        vaultRoot: tmpDir,
      });

      expect(ctx.store).toBeDefined();
      expect(ctx.store.projectId).toBe("test-project");
      expect(ctx.dataDir).toBe(testProjectDir);
    });

    it("defaults to _inbox when projectId not provided with vaultRoot", async () => {
      const { createAofMcpContext } = await import("../../mcp/shared.js");
      
      const ctx = await createAofMcpContext({
        dataDir: tmpDir,
        vaultRoot: tmpDir,
      });

      expect(ctx.store).toBeDefined();
      expect(ctx.store.projectId).toBe("_inbox");
      expect(ctx.dataDir).toBe(inboxDir);
    });

    it("uses dataDir directly when no project params", async () => {
      const { createAofMcpContext } = await import("../../mcp/shared.js");
      
      // Create a standalone dataDir (not under Projects/)
      const standaloneDir = join(tmpDir, "standalone");
      await mkdir(join(standaloneDir, "tasks", "backlog"), { recursive: true });
      
      const ctx = await createAofMcpContext({
        dataDir: standaloneDir,
      });

      expect(ctx.store).toBeDefined();
      expect(ctx.dataDir).toBe(standaloneDir);
    });
  });
});
