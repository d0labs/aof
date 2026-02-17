/**
 * aof_dispatch Tests
 * 
 * Tests high-level dispatch function that integrates context assembly
 * with the DispatchExecutor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { MockExecutor } from "../executor.js";
import { aofDispatch } from "../aof-dispatch.js";

describe("aof_dispatch", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let executor: MockExecutor;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dispatch-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    executor = new MockExecutor();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("Basic dispatch", () => {
    it("dispatches a task and returns dispatch result", async () => {
      const task = await store.create({
        title: "Dispatch test",
        body: "Task to dispatch",
        routing: { agent: "test-agent" },
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.context).toBeDefined();
      expect(result.context?.totalChars).toBeGreaterThan(0);
      expect(result.taskStatus).toBe("in-progress");
    });

    it("uses agent from task routing when agentId not provided", async () => {
      const task = await store.create({
        title: "Agent routing test",
        body: "Task body",
        routing: { agent: "swe-backend" },
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      expect(executor.spawned).toHaveLength(1);
      expect(executor.spawned[0].context.agent).toBe("swe-backend");
    });

    it("allows agentId override to bypass task routing", async () => {
      const task = await store.create({
        title: "Override test",
        body: "Task body",
        routing: { agent: "agent-from-card" },
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      await aofDispatch({
        taskId: task.frontmatter.id,
        agentId: "override-agent",
        store,
        executor,
      });

      expect(executor.spawned).toHaveLength(1);
      expect(executor.spawned[0].context.agent).toBe("override-agent");
    });

    it("transitions task to in-progress before dispatch", async () => {
      const task = await store.create({
        title: "Status transition test",
        body: "Task body",
        routing: { agent: "test-agent" },
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
    });

    it("throws error when task not found", async () => {
      await expect(
        aofDispatch({
          taskId: "TASK-2024-01-01-999",
          store,
          executor,
        })
      ).rejects.toThrow("Task not found");
    });

    it("throws error when no agent specified", async () => {
      const task = await store.create({
        title: "No agent test",
        body: "Task body",
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      await expect(
        aofDispatch({
          taskId: task.frontmatter.id,
          store,
          executor,
        })
      ).rejects.toThrow("No agent specified");
    });
  });

  describe("Context assembly integration", () => {
    it("assembles context from task card and inputs", async () => {
      const task = await store.create({
        title: "Context test",
        body: "Main task description",
        routing: { agent: "test-agent" },
        createdBy: "test",
      });

      // Add input files
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "brief.md"), "# Brief\n\nProject context", "utf-8");

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      expect(result.context).toBeDefined();
      expect(result.context!.summary).toContain("Context test");
      expect(result.context!.summary).toContain("Brief");
      expect(result.context!.sources.length).toBeGreaterThan(1);
    });

    it("respects maxChars option in context assembly", async () => {
      const task = await store.create({
        title: "Budget test",
        body: "A".repeat(5000),
        routing: { agent: "test-agent" },
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
        contextOpts: { maxChars: 2000 },
      });

      expect(result.context).toBeDefined();
      expect(result.context!.totalChars).toBeLessThanOrEqual(2000);
    });
  });

  describe("Error handling", () => {
    it("returns failure result when executor fails", async () => {
      const task = await store.create({
        title: "Executor failure test",
        body: "Task body",
        routing: { agent: "test-agent" },
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      executor.setShouldFail(true, "Spawn failed");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Spawn failed");
    });

    it("handles missing task gracefully", async () => {
      await expect(
        aofDispatch({
          taskId: "TASK-9999-99-99-999",
          store,
          executor,
        })
      ).rejects.toThrow();
    });
  });

  describe("Result metadata", () => {
    it("includes context statistics in result", async () => {
      const task = await store.create({
        title: "Metadata test",
        body: "Task body",
        routing: { agent: "test-agent" },
        createdBy: "test",
      });

      await store.transition(task.frontmatter.id, "ready");

      const result = await aofDispatch({
        taskId: task.frontmatter.id,
        store,
        executor,
      });

      expect(result.context).toBeDefined();
      expect(result.context!.totalChars).toBeGreaterThan(0);
      expect(result.context!.manifest).toBeDefined();
      expect(result.context!.manifest.taskId).toBe(task.frontmatter.id);
    });
  });
});
