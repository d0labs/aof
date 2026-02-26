/**
 * E2E Test Suite 4: Dispatch Flow
 * 
 * Tests the full dispatch pipeline:
 * - Task context assembly + dispatch
 * - Task status transitions during dispatch
 * - Context bundle includes task card + input files
 * - Character budget truncation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { aofDispatch, type DispatchResult } from "../../../src/dispatch/aof-dispatch.js";
import type { GatewayAdapter } from "../../../src/dispatch/executor.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "dispatch-flow");

/**
 * Mock GatewayAdapter for testing dispatch flow without actual agent spawning.
 */
class MockDispatchAdapter implements GatewayAdapter {
  public lastSpawnOptions: any = null;

  async spawnSession(options: any): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    this.lastSpawnOptions = options;
    return {
      success: true,
      sessionId: `mock-session-${Date.now()}`,
    };
  }

  async getSessionStatus(sessionId: string) {
    return { sessionId, alive: false };
  }

  async forceCompleteSession(_sessionId: string) {}
}

describe("E2E: Dispatch Flow", () => {
  let store: ITaskStore;
  let executor: MockDispatchAdapter;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    executor = new MockDispatchAdapter();
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("basic dispatch flow", () => {
    it("should dispatch a task with context assembly", async () => {
      // Create task with routing info
      const task = await store.create({
        title: "Dispatch Test Task",
        body: "# Task\n\nThis task should be dispatched.",
        createdBy: "system",
        routing: {
          agent: "test-agent-1",
        },
      });

      // Move to ready status (required for dispatch)
      await store.transition(task.frontmatter.id, "ready");

      // Create inputs directory with test files
      const taskDir = join(TEST_DATA_DIR, "tasks", "ready");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "context.txt"), "Additional context for the task.");
      await writeFile(join(inputsDir, "requirements.md"), "# Requirements\n\n- Must do X\n- Must do Y");

      // Dispatch the task
      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      // Verify dispatch result
      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.context).toBeDefined();

      // Verify context bundle structure
      expect(result.context?.summary).toBeDefined();
      expect(result.context?.totalChars).toBeGreaterThan(0);
      expect(result.context?.sources.length).toBeGreaterThan(0);
      expect(result.context?.manifest).toBeDefined();

      // Verify task transitioned to in-progress
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
    });

    it("should include task card in context bundle", async () => {
      const taskBody = "# Important Task\n\nThis is the task description with important context.";
      const task = await store.create({
        title: "Context Test",
        body: taskBody,
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      // Context should include task body
      expect(result.context?.summary).toContain("Important Task");
      expect(result.context?.summary).toContain("important context");
    });

    it("should include all input files in context bundle", async () => {
      const task = await store.create({
        title: "Multi-Input Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      await store.transition(task.frontmatter.id, "ready");

      // Create multiple input files
      const taskDir = join(TEST_DATA_DIR, "tasks", "ready");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "file1.txt"), "Content from file 1");
      await writeFile(join(inputsDir, "file2.txt"), "Content from file 2");
      await writeFile(join(inputsDir, "file3.md"), "# File 3\n\nMarkdown content");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      // All input files should be in sources
      expect(result.context?.sources.length).toBeGreaterThan(3); // Task card + 3 inputs
      
      // Content should include all files
      const summary = result.context?.summary ?? "";
      expect(summary).toContain("file1.txt");
      expect(summary).toContain("file2.txt");
      expect(summary).toContain("file3.md");
      expect(summary).toContain("Content from file 1");
      expect(summary).toContain("Content from file 2");
      expect(summary).toContain("Markdown content");
    });
  });

  describe("context budget management", () => {
    it("should respect character budget limit", async () => {
      const task = await store.create({
        title: "Budget Test",
        body: "# Task\n\nShort task body.",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      await store.transition(task.frontmatter.id, "ready");

      // Create large input file
      const taskDir = join(TEST_DATA_DIR, "tasks", "ready");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      const largeContent = "X".repeat(10000); // 10k chars
      await writeFile(join(inputsDir, "large-file.txt"), largeContent);

      // Dispatch with tight budget
      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
        contextOpts: {
          maxChars: 1000, // Only 1k chars allowed
        },
      });

      // Context should be truncated
      expect(result.context?.totalChars).toBeLessThanOrEqual(1100); // Some overhead allowed
      expect(result.context?.summary).toBeDefined();
      expect(result.context?.summary.length).toBeLessThan(1200);
    });

    it("should include truncation notice when budget exceeded", async () => {
      const task = await store.create({
        title: "Truncation Test",
        body: "# Task\n\nBody content.",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      await store.transition(task.frontmatter.id, "ready");

      const taskDir = join(TEST_DATA_DIR, "tasks", "ready");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "input.txt"), "A".repeat(5000));

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
        contextOpts: { maxChars: 800 }, // Task card + some content, then truncate
      });

      // With tight budget, should trigger truncation
      expect(result.context?.totalChars).toBeLessThanOrEqual(850);
      expect(result.context?.summary.length).toBeLessThan(900);
    });

    it("should handle no budget limit (unbounded context)", async () => {
      const task = await store.create({
        title: "Unbounded Test",
        body: "# Task with no limits",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      await store.transition(task.frontmatter.id, "ready");

      const taskDir = join(TEST_DATA_DIR, "tasks", "ready");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "big-file.txt"), "Z".repeat(5000));

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
        // No contextOpts means no budget limit
      });

      expect(result.context?.totalChars).toBeGreaterThan(5000);
      expect(result.context?.summary).not.toContain("truncated");
    });
  });

  describe("task status transitions", () => {
    it("should require ready status before dispatch", async () => {
      const task = await store.create({
        title: "Backlog Dispatch Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      expect(task.frontmatter.status).toBe("backlog");

      // Move to ready (required for dispatch)
      await store.transition(task.frontmatter.id, "ready");

      await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
    });

    it("should transition task from ready to in-progress", async () => {
      const task = await store.create({
        title: "Ready Dispatch",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      // Move to ready first
      await store.transition(task.frontmatter.id, "ready");

      await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
    });

    it("should handle already in-progress task", async () => {
      const task = await store.create({
        title: "Already In Progress",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      // Should not fail when already in-progress
      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      expect(result.success).toBe(true);
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
    });
  });

  describe("agent routing", () => {
    it("should use agent from routing field", async () => {
      const task = await store.create({
        title: "Routing Test",
        body: "# Task",
        createdBy: "system",
        routing: {
          agent: "specific-agent-123",
        },
      });

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      expect(result.success).toBe(true);
      expect(executor.lastSpawnOptions.agent).toBe("specific-agent-123");
    });

    it("should use explicit agentId parameter over routing field", async () => {
      const task = await store.create({
        title: "Override Test",
        body: "# Task",
        createdBy: "system",
        routing: {
          agent: "default-agent",
        },
      });

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        agentId: "override-agent",
        store,
        executor,
      });

      expect(result.success).toBe(true);
      expect(executor.lastSpawnOptions.agent).toBe("override-agent");
    });

    it("should throw error when no agent specified", async () => {
      const task = await store.create({
        title: "No Agent Test",
        body: "# Task",
        createdBy: "system",
        // No routing field
      });

      await expect(
        aofDispatch({
          taskId: task.frontmatter.id,
          store,
          executor,
        })
      ).rejects.toThrow(/no agent specified/i);
    });
  });

  describe("error handling", () => {
    it("should handle non-existent task", async () => {
      await expect(
        aofDispatch({
          taskId: "TASK-9999-99-99-999",
          store,
          executor,
        })
      ).rejects.toThrow(/not found/i);
    });

    it("should return error when executor spawn fails", async () => {
      const failingExecutor: GatewayAdapter = {
        async spawnSession() {
          return {
            success: false,
            error: "Mock spawn failure",
          };
        },
        async getSessionStatus(sid) { return { sessionId: sid, alive: false }; },
        async forceCompleteSession() {},
      };

      const task = await store.create({
        title: "Spawn Failure Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "test-agent" },
      });

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor: failingExecutor,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Mock spawn failure");
    });
  });

  describe("context manifest", () => {
    it("should generate manifest with seed layer", async () => {
      const task = await store.create({
        title: "Manifest Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "test-agent-1" },
      });

      await store.transition(task.frontmatter.id, "ready");

      const taskDir = join(TEST_DATA_DIR, "tasks", "ready");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "input.txt"), "Input content");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      const manifest = result.context?.manifest;
      expect(manifest).toBeDefined();
      expect(manifest?.version).toBe("v1");
      expect(manifest?.taskId).toBe(task.frontmatter.id);
      expect(manifest?.layers.seed).toBeDefined();
      expect(manifest?.layers.seed.length).toBeGreaterThan(0);
    });
  });
});
