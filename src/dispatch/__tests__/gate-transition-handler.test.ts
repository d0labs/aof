/**
 * Gate transition handler tests — integration between gate evaluator and task store.
 *
 * Test coverage:
 * - Load project manifest successfully
 * - Load project manifest: missing file
 * - Load project manifest: invalid YAML
 * - Load project manifest: schema validation failure
 * - Handle gate transition: complete outcome (advance to next gate)
 * - Handle gate transition: needs_review outcome (loop back to first gate)
 * - Handle gate transition: blocked outcome (stay in current gate)
 * - Handle gate transition: task not found
 * - Handle gate transition: task not in workflow
 * - Handle gate transition: project has no workflow
 * - Handle gate transition: invalid workflow config
 * - Apply gate transition: update task atomically
 * - Emit gate_transition event
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import writeFileAtomic from "write-file-atomic";
import { FilesystemTaskStore, serializeTask } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { handleGateTransition, loadProjectManifest } from "../gate-transition-handler.js";
import type { Task } from "../../schemas/task.js";

describe("gate-transition-handler", () => {
  let projectRoot: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "aof-gate-handler-test-"));
    await mkdir(join(projectRoot, "tasks"), { recursive: true });
    await mkdir(join(projectRoot, "events"), { recursive: true });
    store = new FilesystemTaskStore(projectRoot);
    await store.init();
    logger = new EventLogger(join(projectRoot, "events"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe("loadProjectManifest", () => {
    it("should load and validate project manifest", async () => {
      const manifestYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: swe
  lead: alice
workflow:
  name: default
  rejectionStrategy: origin
  gates:
    - id: dev
      role: swe-backend
      canReject: false
    - id: qa
      role: swe-qa
      canReject: true
`;
      await writeFile(join(projectRoot, "project.yaml"), manifestYaml);
      
      const manifest = await loadProjectManifest(projectRoot);
      
      expect(manifest.id).toBe("test-project");
      expect(manifest.title).toBe("Test Project");
      expect(manifest.workflow).toBeDefined();
      expect(manifest.workflow?.name).toBe("default");
      expect(manifest.workflow?.gates).toHaveLength(2);
    });

    it("should throw error when project.yaml is missing", async () => {
      await expect(loadProjectManifest(projectRoot)).rejects.toThrow(
        /Failed to load project manifest/
      );
    });

    it("should throw error when YAML is invalid", async () => {
      await writeFile(join(projectRoot, "project.yaml"), "invalid: yaml: content:");
      
      await expect(loadProjectManifest(projectRoot)).rejects.toThrow(
        /Failed to load project manifest/
      );
    });

    it("should throw error when schema validation fails", async () => {
      const invalidManifest = `
id: INVALID_ID_WITH_CAPS
title: Test
type: swe
status: active
owner:
  team: swe
  lead: alice
`;
      await writeFile(join(projectRoot, "project.yaml"), invalidManifest);
      
      await expect(loadProjectManifest(projectRoot)).rejects.toThrow(
        /Failed to load project manifest/
      );
    });
  });

  describe("handleGateTransition", () => {
    beforeEach(async () => {
      // Create a valid project manifest with workflow
      const manifestYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: swe
  lead: alice
workflow:
  name: default
  rejectionStrategy: origin
  gates:
    - id: dev
      role: swe-backend
      canReject: false
    - id: qa
      role: swe-qa
      canReject: true
    - id: deploy
      role: swe-devops
      canReject: false
`;
      await writeFile(join(projectRoot, "project.yaml"), manifestYaml);
    });

    it("should handle complete outcome and advance to next gate", async () => {
      // Create a task in the first gate
      const task = await store.create({
        title: "Test task",
        body: "Task body",
        priority: "normal",
        routing: { role: "swe-backend", workflow: "default" },
        createdBy: "test",
      });
      
      // Set gate state manually (simulating task in workflow)
      const loadedTask = await store.get(task.frontmatter.id);
      if (!loadedTask) throw new Error("Task not found");
      loadedTask.frontmatter.gate = {
        current: "dev",
        entered: new Date().toISOString(),
      };
      const filePath = loadedTask.path ?? join(store.projectRoot, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
      await writeFileAtomic(filePath, serializeTask(loadedTask));
      
      // Handle gate transition
      const transition = await handleGateTransition(
        store,
        logger,
        task.frontmatter.id,
        "complete",
        {
          summary: "Implementation complete",
          agent: "agent-1",
        }
      );
      
      expect(transition.fromGate).toBe("dev");
      expect(transition.toGate).toBe("qa");
      expect(transition.outcome).toBe("complete");
      
      // Verify task state updated
      const updatedTask = await store.get(task.frontmatter.id);
      expect(updatedTask?.frontmatter.gate?.current).toBe("qa");
      expect(updatedTask?.frontmatter.routing.role).toBe("swe-qa");
      expect(updatedTask?.frontmatter.gateHistory).toHaveLength(1);
      expect(updatedTask?.frontmatter.gateHistory?.[0]?.gate).toBe("dev");
      expect(updatedTask?.frontmatter.gateHistory?.[0]?.outcome).toBe("complete");
    });

    it("should handle needs_review outcome and loop back to first gate", async () => {
      // Create a task in QA gate
      const task = await store.create({
        title: "Test task",
        body: "Task body",
        priority: "normal",
        routing: { role: "swe-qa", workflow: "default" },
        createdBy: "test",
      });
      
      const loadedTask = await store.get(task.frontmatter.id);
      if (!loadedTask) throw new Error("Task not found");
      loadedTask.frontmatter.gate = {
        current: "qa",
        entered: new Date().toISOString(),
      };
      const filePath = loadedTask.path ?? join(store.projectRoot, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
      await writeFileAtomic(filePath, serializeTask(loadedTask));
      
      // Handle rejection
      const transition = await handleGateTransition(
        store,
        logger,
        task.frontmatter.id,
        "needs_review",
        {
          summary: "QA failed",
          blockers: ["Missing tests"],
          rejectionNotes: "Please add unit tests",
          agent: "qa-agent",
        }
      );
      
      expect(transition.fromGate).toBe("qa");
      expect(transition.toGate).toBe("dev");
      expect(transition.outcome).toBe("needs_review");
      
      // Verify task state updated
      const updatedTask = await store.get(task.frontmatter.id);
      expect(updatedTask?.frontmatter.gate?.current).toBe("dev");
      expect(updatedTask?.frontmatter.routing.role).toBe("swe-backend");
      expect(updatedTask?.frontmatter.reviewContext).toBeDefined();
      expect(updatedTask?.frontmatter.reviewContext?.fromGate).toBe("qa");
      expect(updatedTask?.frontmatter.reviewContext?.blockers).toContain("Missing tests");
      expect(updatedTask?.frontmatter.reviewContext?.notes).toBe("Please add unit tests");
    });

    it("should handle blocked outcome and stay in current gate", async () => {
      // Create a task in dev gate
      const task = await store.create({
        title: "Test task",
        body: "Task body",
        priority: "normal",
        routing: { role: "swe-backend", workflow: "default" },
        createdBy: "test",
      });
      
      const loadedTask = await store.get(task.frontmatter.id);
      if (!loadedTask) throw new Error("Task not found");
      loadedTask.frontmatter.gate = {
        current: "dev",
        entered: new Date().toISOString(),
      };
      const filePath = loadedTask.path ?? join(store.projectRoot, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
      await writeFileAtomic(filePath, serializeTask(loadedTask));
      
      // Handle block
      const transition = await handleGateTransition(
        store,
        logger,
        task.frontmatter.id,
        "blocked",
        {
          summary: "Blocked by external dependency",
          blockers: ["Waiting for API"],
          agent: "dev-agent",
        }
      );
      
      expect(transition.fromGate).toBe("dev");
      expect(transition.toGate).toBe("dev");
      expect(transition.outcome).toBe("blocked");
      
      // Verify task stayed in same gate with blocked status
      const updatedTask = await store.get(task.frontmatter.id);
      expect(updatedTask?.frontmatter.gate?.current).toBe("dev");
      expect(updatedTask?.frontmatter.status).toBe("blocked");
    });

    it("should throw error when task not found", async () => {
      await expect(
        handleGateTransition(store, logger, "TASK-9999-99-99-999", "complete", {
          summary: "Done",
          agent: "agent-1",
        })
      ).rejects.toThrow(/Task not found/);
    });

    it("should throw error when task not in workflow", async () => {
      // Create a task without gate state
      const task = await store.create({
        title: "Test task",
        body: "Task body",
        priority: "normal",
        routing: { role: "swe-backend" },
        createdBy: "test",
      });
      
      await expect(
        handleGateTransition(store, logger, task.frontmatter.id, "complete", {
          summary: "Done",
          agent: "agent-1",
        })
      ).rejects.toThrow(/not in a gate workflow/);
    });

    it("should throw error when project has no workflow", async () => {
      // Overwrite project.yaml without workflow
      const manifestYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: swe
  lead: alice
`;
      await writeFile(join(projectRoot, "project.yaml"), manifestYaml);
      
      // Create a task with gate state (invalid state)
      const task = await store.create({
        title: "Test task",
        body: "Task body",
        priority: "normal",
        routing: { role: "swe-backend" },
        createdBy: "test",
      });
      
      const loadedTask = await store.get(task.frontmatter.id);
      if (!loadedTask) throw new Error("Task not found");
      loadedTask.frontmatter.gate = {
        current: "dev",
        entered: new Date().toISOString(),
      };
      const filePath = loadedTask.path ?? join(store.projectRoot, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
      await writeFileAtomic(filePath, serializeTask(loadedTask));
      
      await expect(
        handleGateTransition(store, logger, task.frontmatter.id, "complete", {
          summary: "Done",
          agent: "agent-1",
        })
      ).rejects.toThrow(/has no workflow configured/);
    });

    it("should throw error when workflow is invalid", async () => {
      // Create invalid workflow (first gate can reject)
      const manifestYaml = `
id: test-project
title: Test Project
type: swe
status: active
owner:
  team: swe
  lead: alice
workflow:
  name: default
  rejectionStrategy: origin
  gates:
    - id: dev
      role: swe-backend
      canReject: true
`;
      await writeFile(join(projectRoot, "project.yaml"), manifestYaml);
      
      // Create a task in workflow
      const task = await store.create({
        title: "Test task",
        body: "Task body",
        priority: "normal",
        routing: { role: "swe-backend" },
        createdBy: "test",
      });
      
      const loadedTask = await store.get(task.frontmatter.id);
      if (!loadedTask) throw new Error("Task not found");
      loadedTask.frontmatter.gate = {
        current: "dev",
        entered: new Date().toISOString(),
      };
      const filePath = loadedTask.path ?? join(store.projectRoot, "tasks", loadedTask.frontmatter.status, `${loadedTask.frontmatter.id}.md`);
      await writeFileAtomic(filePath, serializeTask(loadedTask));
      
      await expect(
        handleGateTransition(store, logger, task.frontmatter.id, "complete", {
          summary: "Done",
          agent: "agent-1",
        })
      ).rejects.toThrow(/Invalid workflow/);
    });
  });
});
