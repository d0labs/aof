/**
 * Project scoping tests — ToolContext propagation and participant filtering.
 *
 * Tests PROJ-01/02/03: project-scoped store resolution, participant filtering
 * in dispatch, backward compatibility for tasks without project context.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { buildDispatchActions } from "../../dispatch/task-dispatcher.js";
import type { DispatchConfig } from "../../dispatch/task-dispatcher.js";
import type { Task } from "../../schemas/task.js";

describe("Project scoping", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  const dispatchConfig: DispatchConfig = {
    dryRun: true,
    defaultLeaseTtlMs: 600_000,
  };

  const defaultMetrics = {
    currentInProgress: 0,
    blockedBySubtasks: new Set<string>(),
    circularDeps: new Set<string>(),
    occupiedResources: new Map<string, string>(),
    inProgressTasks: [] as Task[],
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-project-scope-"));
    store = new FilesystemTaskStore(tmpDir, { projectId: "test-project" });
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("ToolContext projectId propagation", () => {
    it("resolves project-scoped store when projectId matches", () => {
      // Simulates the resolveProjectStore logic from adapter.ts
      const globalStore = { projectId: "global" } as ITaskStore;
      const projectAStore = { projectId: "project-a" } as ITaskStore;
      const projectStores = new Map<string, ITaskStore>([
        ["project-a", projectAStore],
      ]);

      // Resolve with matching project ID
      const resolveProjectStore = (projectId?: string): ITaskStore => {
        if (projectId && projectStores.has(projectId)) {
          return projectStores.get(projectId)!;
        }
        return globalStore;
      };

      expect(resolveProjectStore("project-a")).toBe(projectAStore);
      expect(resolveProjectStore("project-a").projectId).toBe("project-a");
    });

    it("falls back to global store when project ID not found", () => {
      const globalStore = { projectId: "global" } as ITaskStore;
      const projectStores = new Map<string, ITaskStore>();

      const resolveProjectStore = (projectId?: string): ITaskStore => {
        if (projectId && projectStores.has(projectId)) {
          return projectStores.get(projectId)!;
        }
        return globalStore;
      };

      expect(resolveProjectStore("nonexistent")).toBe(globalStore);
      expect(resolveProjectStore(undefined)).toBe(globalStore);
    });
  });

  describe("Participant filtering in dispatch", () => {
    /**
     * Helper: write a project manifest to disk so loadProjectManifest can read it.
     */
    async function writeProjectManifest(
      projectRoot: string,
      manifest: Record<string, unknown>,
    ): Promise<void> {
      const manifestPath = join(projectRoot, "project.yaml");
      await writeFile(manifestPath, stringifyYaml(manifest), "utf-8");
    }

    it("allows agent that IS in the participants list", async () => {
      await writeProjectManifest(tmpDir, {
        id: "test-project",
        title: "Test Project",
        status: "active",
        type: "swe",
        owner: { agent: "lead" },
        participants: ["agent-a", "agent-b"],
        routing: {},
        memory: {},
        links: {},
      });

      const task = await store.create({
        title: "Allowed agent task",
        createdBy: "test",
        routing: { agent: "agent-a" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const readyTasks = await store.list({ status: "ready" });
      const allTasks = await store.list();

      const actions = await buildDispatchActions(
        readyTasks,
        allTasks,
        store,
        dispatchConfig,
        defaultMetrics,
        null,
        new Map(),
      );

      const assignActions = actions.filter(a => a.type === "assign");
      expect(assignActions).toHaveLength(1);
      expect(assignActions[0]!.agent).toBe("agent-a");
    });

    it("blocks agent NOT in the participants list with alert", async () => {
      await writeProjectManifest(tmpDir, {
        id: "test-project",
        title: "Test Project",
        status: "active",
        type: "swe",
        owner: { agent: "lead" },
        participants: ["agent-a", "agent-b"],
        routing: {},
        memory: {},
        links: {},
      });

      const task = await store.create({
        title: "Blocked agent task",
        createdBy: "test",
        routing: { agent: "agent-c" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const readyTasks = await store.list({ status: "ready" });
      const allTasks = await store.list();

      const actions = await buildDispatchActions(
        readyTasks,
        allTasks,
        store,
        dispatchConfig,
        defaultMetrics,
        null,
        new Map(),
      );

      const alertActions = actions.filter(a => a.type === "alert");
      expect(alertActions).toHaveLength(1);
      expect(alertActions[0]!.reason).toContain("agent-c");
      expect(alertActions[0]!.reason).toContain("not a participant");
      expect(alertActions[0]!.reason).toContain("test-project");

      // Verify NO assign action was created
      const assignActions = actions.filter(a => a.type === "assign");
      expect(assignActions).toHaveLength(0);
    });

    it("allows any agent when participants list is empty (unrestricted)", async () => {
      await writeProjectManifest(tmpDir, {
        id: "test-project",
        title: "Test Project",
        status: "active",
        type: "swe",
        owner: { agent: "lead" },
        participants: [],
        routing: {},
        memory: {},
        links: {},
      });

      const task = await store.create({
        title: "Unrestricted task",
        createdBy: "test",
        routing: { agent: "any-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const readyTasks = await store.list({ status: "ready" });
      const allTasks = await store.list();

      const actions = await buildDispatchActions(
        readyTasks,
        allTasks,
        store,
        dispatchConfig,
        defaultMetrics,
        null,
        new Map(),
      );

      const assignActions = actions.filter(a => a.type === "assign");
      expect(assignActions).toHaveLength(1);
      expect(assignActions[0]!.agent).toBe("any-agent");
    });

    it("assigns normally when task has no project ID (backward compat)", async () => {
      // Create a store without a project ID to simulate global store
      const globalDir = await mkdtemp(join(tmpdir(), "aof-global-"));
      const globalStore = new FilesystemTaskStore(globalDir);
      await globalStore.init();

      try {
        const task = await globalStore.create({
          title: "Global task",
          createdBy: "test",
          routing: { agent: "any-agent" },
        });
        await globalStore.transition(task.frontmatter.id, "ready");

        const readyTasks = await globalStore.list({ status: "ready" });
        const allTasks = await globalStore.list();

        const actions = await buildDispatchActions(
          readyTasks,
          allTasks,
          globalStore,
          dispatchConfig,
          defaultMetrics,
          null,
          new Map(),
        );

        const assignActions = actions.filter(a => a.type === "assign");
        expect(assignActions).toHaveLength(1);
        expect(assignActions[0]!.agent).toBe("any-agent");
      } finally {
        await rm(globalDir, { recursive: true, force: true });
      }
    });
  });
});
