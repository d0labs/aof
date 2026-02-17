import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("TaskStore dependency management", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let eventLog: BaseEvent[];
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-test-deps-"));
    eventLog = [];
    
    // Create logger with event capture
    const eventsDir = join(tmpDir, "events");
    logger = new EventLogger(eventsDir, {
      onEvent: (event) => {
        eventLog.push(event);
      },
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("addDep", () => {
    it("adds a dependency to a task (happy path)", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      const updated = await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);

      expect(updated.frontmatter.dependsOn).toContain(taskB.frontmatter.id);
      expect(updated.frontmatter.dependsOn).toHaveLength(1);
      
      // Verify it persisted
      const loaded = await store.get(taskA.frontmatter.id);
      expect(loaded!.frontmatter.dependsOn).toContain(taskB.frontmatter.id);
    });

    it("emits task.dep.added event", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      eventLog = []; // Reset after creates
      await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);

      const depEvent = eventLog.find((e) => e.type === "task.dep.added");
      expect(depEvent).toBeDefined();
      expect(depEvent!.payload).toMatchObject({
        taskId: taskA.frontmatter.id,
        blockerId: taskB.frontmatter.id,
      });
    });

    it("updates updatedAt timestamp", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      const originalUpdatedAt = taskA.frontmatter.updatedAt;
      
      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      const updated = await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);
      
      expect(updated.frontmatter.updatedAt).not.toBe(originalUpdatedAt);
      expect(new Date(updated.frontmatter.updatedAt).getTime()).toBeGreaterThan(
        new Date(originalUpdatedAt).getTime()
      );
    });

    it("rejects adding dependency to nonexistent task", async () => {
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      await expect(
        store.addDep("TASK-2026-01-01-999", taskB.frontmatter.id)
      ).rejects.toThrow("Task not found: TASK-2026-01-01-999");
    });

    it("rejects adding nonexistent blocker task", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });

      await expect(
        store.addDep(taskA.frontmatter.id, "TASK-2026-01-01-999")
      ).rejects.toThrow("Blocker task not found: TASK-2026-01-01-999");
    });

    it("rejects self-dependency", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });

      await expect(
        store.addDep(taskA.frontmatter.id, taskA.frontmatter.id)
      ).rejects.toThrow("Task cannot depend on itself");
    });

    it("rejects circular dependency (direct cycle)", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      // A depends on B
      await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);

      // Try to make B depend on A (creates cycle: A -> B -> A)
      await expect(
        store.addDep(taskB.frontmatter.id, taskA.frontmatter.id)
      ).rejects.toThrow("circular dependency");
    });

    it("rejects circular dependency (transitive cycle)", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });
      const taskC = await store.create({ title: "Task C", createdBy: "test" });

      // A depends on B
      await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);
      
      // B depends on C
      await store.addDep(taskB.frontmatter.id, taskC.frontmatter.id);

      // Try to make C depend on A (creates cycle: A -> B -> C -> A)
      await expect(
        store.addDep(taskC.frontmatter.id, taskA.frontmatter.id)
      ).rejects.toThrow("circular dependency");
    });

    it("is idempotent (adding same dependency twice)", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);
      const result = await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);

      expect(result.frontmatter.dependsOn).toHaveLength(1);
      expect(result.frontmatter.dependsOn).toContain(taskB.frontmatter.id);
    });
  });

  describe("removeDep", () => {
    it("removes a dependency from a task (happy path)", async () => {
      const taskA = await store.create({ 
        title: "Task A", 
        createdBy: "test",
        dependsOn: [],
      });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      // Add dependency first
      await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);
      
      // Verify it was added
      let loaded = await store.get(taskA.frontmatter.id);
      expect(loaded!.frontmatter.dependsOn).toContain(taskB.frontmatter.id);

      // Remove it
      const updated = await store.removeDep(taskA.frontmatter.id, taskB.frontmatter.id);
      expect(updated.frontmatter.dependsOn).not.toContain(taskB.frontmatter.id);
      expect(updated.frontmatter.dependsOn).toHaveLength(0);

      // Verify it persisted
      loaded = await store.get(taskA.frontmatter.id);
      expect(loaded!.frontmatter.dependsOn).not.toContain(taskB.frontmatter.id);
    });

    it("emits task.dep.removed event", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);
      
      eventLog = []; // Reset after add
      await store.removeDep(taskA.frontmatter.id, taskB.frontmatter.id);

      const depEvent = eventLog.find((e) => e.type === "task.dep.removed");
      expect(depEvent).toBeDefined();
      expect(depEvent!.payload).toMatchObject({
        taskId: taskA.frontmatter.id,
        blockerId: taskB.frontmatter.id,
      });
    });

    it("updates updatedAt timestamp", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      await store.addDep(taskA.frontmatter.id, taskB.frontmatter.id);
      const beforeRemove = (await store.get(taskA.frontmatter.id))!.frontmatter.updatedAt;
      
      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      const updated = await store.removeDep(taskA.frontmatter.id, taskB.frontmatter.id);
      
      expect(updated.frontmatter.updatedAt).not.toBe(beforeRemove);
      expect(new Date(updated.frontmatter.updatedAt).getTime()).toBeGreaterThan(
        new Date(beforeRemove).getTime()
      );
    });

    it("rejects removing from nonexistent task", async () => {
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      await expect(
        store.removeDep("TASK-2026-01-01-999", taskB.frontmatter.id)
      ).rejects.toThrow("Task not found: TASK-2026-01-01-999");
    });

    it("is idempotent (removing nonexistent dependency)", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "test" });
      const taskB = await store.create({ title: "Task B", createdBy: "test" });

      // Remove without adding first
      const result = await store.removeDep(taskA.frontmatter.id, taskB.frontmatter.id);
      
      expect(result.frontmatter.dependsOn).toHaveLength(0);
    });
  });
});
