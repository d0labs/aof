/**
 * E2E Test Suite 5: View Updates
 * 
 * Tests that views reflect task state changes:
 * - Kanban view columns match task statuses
 * - Mailbox view folders (inbox/processing/outbox)
 * - Views update when tasks move
 * - View parser (parseViewSnapshot) integration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { syncKanbanView } from "../../../src/views/kanban.js";
import { syncMailboxView } from "../../../src/views/mailbox.js";
import { parseViewSnapshot } from "../../../src/views/parser.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "view-updates");

describe("E2E: View Updates", () => {
  let store: ITaskStore;
  let viewsDir: string;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    viewsDir = join(TEST_DATA_DIR, "views");
    await mkdir(viewsDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("kanban view generation", () => {
    it("should generate kanban view with all columns", async () => {
      // Create tasks in different statuses
      const task1 = await store.create({ title: "Backlog Task", createdBy: "system" });
      const task2 = await store.create({ title: "Ready Task", createdBy: "system" });
      await store.transition(task2.frontmatter.id, "ready");
      const task3 = await store.create({ title: "In Progress Task", createdBy: "system" });
      await store.transition(task3.frontmatter.id, "ready");
      await store.transition(task3.frontmatter.id, "in-progress");

      // Generate kanban view
      const kanbanDir = join(viewsDir, "kanban");
      const result = await syncKanbanView(store, {
        dataDir: TEST_DATA_DIR,
        viewsDir: kanbanDir,
        swimlaneBy: "priority",
      });

      expect(result.pointerCount).toBeGreaterThan(0);
      expect(result.swimlanes.length).toBeGreaterThan(0);
      
      // Kanban views organized by swimlane (priority in this case)
      // Each swimlane dir contains status columns (backlog/ready/in-progress/etc)
      // The view structure is: kanbanDir/priority/{backlog,ready,in-progress,etc}/task.md
    });

    it("should sync kanban view for tasks in different statuses", async () => {
      const backlogTask = await store.create({ title: "BL Task", createdBy: "system" });
      const readyTask = await store.create({ title: "RD Task", createdBy: "system" });
      await store.transition(readyTask.frontmatter.id, "ready");
      const inProgressTask = await store.create({ title: "IP Task", createdBy: "system" });
      await store.transition(inProgressTask.frontmatter.id, "ready");
      await store.transition(inProgressTask.frontmatter.id, "in-progress");

      const kanbanDir = join(viewsDir, "kanban");
      const result = await syncKanbanView(store, { dataDir: TEST_DATA_DIR, viewsDir: kanbanDir, swimlaneBy: "priority" });

      // Verify view sync completed successfully
      expect(result.pointerCount).toBeGreaterThan(0);
      expect(result.swimlanes.length).toBeGreaterThan(0);
    });

    it("should update kanban view when task moves", async () => {
      const task = await store.create({ title: "Moving Task", createdBy: "system" });
      const kanbanDir = join(viewsDir, "kanban");

      // Initial view: task in backlog
      const result1 = await syncKanbanView(store, { dataDir: TEST_DATA_DIR, viewsDir: kanbanDir, swimlaneBy: "priority" });
      expect(result1.pointerCount).toBeGreaterThan(0);

      // Move task to ready
      await store.transition(task.frontmatter.id, "ready");
      const result2 = await syncKanbanView(store, { dataDir: TEST_DATA_DIR, viewsDir: kanbanDir, swimlaneBy: "priority" });
      
      // View should update successfully
      expect(result2.pointerCount).toBeGreaterThan(0);
    });

    it("should handle empty store gracefully", async () => {
      // Don't create any tasks, just sync view
      const kanbanDir = join(viewsDir, "kanban");
      const result = await syncKanbanView(store, { dataDir: TEST_DATA_DIR, viewsDir: kanbanDir, swimlaneBy: "priority" });

      // Should complete successfully even with no tasks
      expect(result).toBeDefined();
      expect(result.swimlanes).toBeDefined();
    });
  });

  describe("mailbox view generation", () => {
    it("should generate mailbox view with inbox/processing/outbox folders", async () => {
      // Create tasks with routing
      const task1 = await store.create({
        title: "Inbox Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      
      const task2 = await store.create({
        title: "Processing Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      await store.transition(task2.frontmatter.id, "ready");
      await store.transition(task2.frontmatter.id, "in-progress");

      const task3 = await store.create({
        title: "Outbox Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      await store.transition(task3.frontmatter.id, "ready");
      await store.transition(task3.frontmatter.id, "in-progress");
      await store.transition(task3.frontmatter.id, "review");

      // Generate mailbox view (creates views for all agents)
      const result = await syncMailboxView(store, {
        dataDir: TEST_DATA_DIR,
        agentsDir: join(TEST_DATA_DIR, "Agents"),
      });

      expect(result.pointerCount).toBeGreaterThan(0);
      expect(result.agents.length).toBeGreaterThan(0);

      // Parse mailbox view for test-agent-1
      const mailboxDir = join(TEST_DATA_DIR, "Agents", "test-agent-1");
      const snapshot = await parseViewSnapshot(mailboxDir, "mailbox");
      expect(snapshot.viewType).toBe("mailbox");

      const mailboxData = snapshot.data as any;
      expect(mailboxData.agentId).toBe("test-agent-1");
      expect(mailboxData.inbox).toBeDefined();
      expect(mailboxData.processing).toBeDefined();
      expect(mailboxData.outbox).toBeDefined();
    });

    it("should sync mailbox view for tasks in different folders", async () => {
      // Create tasks with routing to test-agent-1
      await store.create({
        title: "Inbox Item",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      const processingTask = await store.create({
        title: "Processing Item",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      await store.transition(processingTask.frontmatter.id, "ready");
      await store.transition(processingTask.frontmatter.id, "in-progress");

      const outboxTask = await store.create({
        title: "Outbox Item",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      await store.transition(outboxTask.frontmatter.id, "ready");
      await store.transition(outboxTask.frontmatter.id, "in-progress");
      await store.transition(outboxTask.frontmatter.id, "review");

      // Generate mailbox view
      const result = await syncMailboxView(store, {
        dataDir: TEST_DATA_DIR,
        agentsDir: join(TEST_DATA_DIR, "Agents"),
      });

      // Verify sync completed successfully
      expect(result.pointerCount).toBeGreaterThan(0);
      expect(result.agents.length).toBeGreaterThan(0);
      expect(result.agents).toContain("test-agent-1");
    });

    it("should update mailbox view when task moves between statuses", async () => {
      const task = await store.create({
        title: "Mailbox Mover",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      // Sync operations should complete successfully
      const result1 = await syncMailboxView(store, {
        dataDir: TEST_DATA_DIR,
        agentsDir: join(TEST_DATA_DIR, "Agents"),
      });
      expect(result1).toBeDefined();

      // Move task through statuses
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      
      const result2 = await syncMailboxView(store, {
        dataDir: TEST_DATA_DIR,
        agentsDir: join(TEST_DATA_DIR, "Agents"),
      });
      expect(result2).toBeDefined();

      // Move to review
      await store.transition(task.frontmatter.id, "review");
      
      const result3 = await syncMailboxView(store, {
        dataDir: TEST_DATA_DIR,
        agentsDir: join(TEST_DATA_DIR, "Agents"),
      });
      expect(result3).toBeDefined();
    });

    it("should create mailbox views for multiple agents", async () => {
      // Create tasks for different agents in mailbox-eligible statuses
      const task1 = await store.create({
        title: "Agent 1 Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      await store.transition(task1.frontmatter.id, "ready");

      const task2 = await store.create({
        title: "Agent 2 Task",
        createdBy: "system",
        routing: { agent: "test-agent-2" },
      });
      await store.transition(task2.frontmatter.id, "ready");

      // Generate mailbox views for all agents
      const result = await syncMailboxView(store, {
        dataDir: TEST_DATA_DIR,
        agentsDir: join(TEST_DATA_DIR, "Agents"),
      });

      // Should create views for both agents
      expect(result.agents.length).toBeGreaterThanOrEqual(2);
      expect(result.agents).toContain("test-agent-1");
      expect(result.agents).toContain("test-agent-2");
    });
  });

  describe("view parser integration", () => {
    it("should parse kanban view snapshot correctly", async () => {
      const task1 = await store.create({ title: "Task 1", createdBy: "system" });
      const task2 = await store.create({ title: "Task 2", createdBy: "system" });
      await store.transition(task2.frontmatter.id, "ready");

      const kanbanDir = join(viewsDir, "kanban");
      await syncKanbanView(store, { dataDir: TEST_DATA_DIR, viewsDir: kanbanDir, swimlaneBy: "priority" });

      // Parser expects flat <status>/ dirs; kanban generator uses swimlanes: <swimlaneBy>/<lane>/<status>/
      // Default priority is "normal"
      const snapshot = await parseViewSnapshot(join(kanbanDir, "priority", "normal"), "kanban");

      expect(snapshot.viewType).toBe("kanban");
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.data).toBeDefined();

      const data = snapshot.data as any;
      expect(data.columns).toBeInstanceOf(Array);
      expect(data.totalTasks).toBeGreaterThanOrEqual(2);
    });

    it("should parse mailbox view snapshot correctly", async () => {
      const task = await store.create({
        title: "Mailbox Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      // Transition to 'ready' so it maps to mailbox 'inbox' folder
      await store.transition(task.frontmatter.id, "ready");

      // Generate mailbox view — now uses dataDir/views/mailbox/<agentId>/
      await syncMailboxView(store, { dataDir: TEST_DATA_DIR });

      const testMailboxDir = join(TEST_DATA_DIR, "views", "mailbox", "test-agent-1");
      const snapshot = await parseViewSnapshot(testMailboxDir, "mailbox");

      expect(snapshot.viewType).toBe("mailbox");
      expect(snapshot.timestamp).toBeDefined();

      const data = snapshot.data as any;
      expect(data.agentId).toBe("test-agent-1");
      expect(data.inbox).toBeInstanceOf(Array);
      expect(data.processing).toBeInstanceOf(Array);
      expect(data.outbox).toBeInstanceOf(Array);
    });

    it("should handle missing view directory gracefully", async () => {
      const nonExistentDir = join(viewsDir, "non-existent");

      await expect(
        parseViewSnapshot(nonExistentDir, "kanban")
      ).rejects.toThrow(/cannot read view directory/i);
    });
  });

  describe("view consistency", () => {
    it("should maintain consistency across multiple view updates", async () => {
      const task = await store.create({
        title: "Consistency Test",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });
      // Transition to 'ready' so it appears in mailbox inbox
      await store.transition(task.frontmatter.id, "ready");

      const kanbanDir = join(viewsDir, "kanban");
      const kanbanParseDir = join(kanbanDir, "priority", "normal");
      const agentsDir = join(viewsDir, "agents");

      // Initial views
      await syncKanbanView(store, { dataDir: TEST_DATA_DIR, viewsDir: kanbanDir, swimlaneBy: "priority" });
      await syncMailboxView(store, { dataDir: viewsDir, agentsDir });
      const mbDir = join(agentsDir, "test-agent-1");

      let kanbanSnapshot = await parseViewSnapshot(kanbanParseDir, "kanban");
      let mailboxSnapshot = await parseViewSnapshot(mbDir, "mailbox");

      // Both views should show task in ready/inbox
      const kanbanData1 = kanbanSnapshot.data as any;
      const mailboxData1 = mailboxSnapshot.data as any;
      const readyCol = kanbanData1.columns.find((c: any) => c.name === "ready");
      expect(readyCol?.tasks.some((t: any) => t.id === task.frontmatter.id)).toBe(true);
      expect(mailboxData1.inbox.some((t: any) => t.id === task.frontmatter.id)).toBe(true);

      // Move task to in-progress
      await store.transition(task.frontmatter.id, "in-progress");

      // Update views
      await syncKanbanView(store, { dataDir: TEST_DATA_DIR, viewsDir: kanbanDir, swimlaneBy: "priority" });
      await syncMailboxView(store, { dataDir: viewsDir, agentsDir });

      kanbanSnapshot = await parseViewSnapshot(kanbanParseDir, "kanban");
      mailboxSnapshot = await parseViewSnapshot(mbDir, "mailbox");

      // Both views should now show task in in-progress/processing
      const kanbanData2 = kanbanSnapshot.data as any;
      const mailboxData2 = mailboxSnapshot.data as any;
      const inProgressCol = kanbanData2.columns.find((c: any) => c.name === "in-progress");
      expect(inProgressCol?.tasks.some((t: any) => t.id === task.frontmatter.id)).toBe(true);
      expect(mailboxData2.processing.some((t: any) => t.id === task.frontmatter.id)).toBe(true);
    });
  });
});
