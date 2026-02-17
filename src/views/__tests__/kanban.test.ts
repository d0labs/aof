import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { syncKanbanView, createKanbanHooks } from "../kanban.js";

const toPosixPath = (value: string) => value.split(sep).join("/");

describe("kanban view", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-kanban-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates kanban pointers by priority", async () => {
    const highTask = await store.create({
      title: "High task",
      createdBy: "main",
      priority: "high",
    });
    const highReady = await store.transition(highTask.frontmatter.id, "ready");

    const normalTask = await store.create({
      title: "Normal task",
      createdBy: "main",
      priority: "normal",
    });
    await store.transition(normalTask.frontmatter.id, "ready");
    const normalInProgress = await store.transition(normalTask.frontmatter.id, "in-progress");

    await syncKanbanView(store, { dataDir: tmpDir, swimlaneBy: "priority" });

    const highPath = join(
      tmpDir,
      "views",
      "kanban",
      "priority",
      "high",
      "ready",
      `${highTask.frontmatter.id}.md`,
    );
    const normalPath = join(
      tmpDir,
      "views",
      "kanban",
      "priority",
      "normal",
      "in-progress",
      `${normalTask.frontmatter.id}.md`,
    );

    await expect(stat(highPath)).resolves.toBeDefined();
    await expect(stat(normalPath)).resolves.toBeDefined();

    const highContents = await readFile(highPath, "utf-8");
    const highCanonical = toPosixPath(
      relative(
        join(tmpDir, "views", "kanban", "priority", "high", "ready"),
        highReady.path!,
      ),
    );
    expect(highContents).toContain(`priority: high`);
    expect(highContents).toContain(`Canonical: ${highCanonical}`);

    const normalContents = await readFile(normalPath, "utf-8");
    const normalCanonical = toPosixPath(
      relative(
        join(tmpDir, "views", "kanban", "priority", "normal", "in-progress"),
        normalInProgress.path!,
      ),
    );
    expect(normalContents).toContain(`status: in-progress`);
    expect(normalContents).toContain(`Canonical: ${normalCanonical}`);
  });

  it("generates kanban pointers by project", async () => {
    const projectTask = await store.create({
      title: "Project task",
      createdBy: "main",
      metadata: { project: "Alpha" },
    });
    await store.transition(projectTask.frontmatter.id, "ready");

    await syncKanbanView(store, { dataDir: tmpDir, swimlaneBy: "project" });

    const projectPath = join(
      tmpDir,
      "views",
      "kanban",
      "project",
      "Alpha",
      "ready",
      `${projectTask.frontmatter.id}.md`,
    );

    await expect(stat(projectPath)).resolves.toBeDefined();
  });

  it("updates pointers on transitions via hooks", async () => {
    let hookedStore: ITaskStore;
    const hooks = createKanbanHooks(() => hookedStore, {
      dataDir: tmpDir,
      swimlaneBy: "priority",
    });
    hookedStore = new FilesystemTaskStore(tmpDir, { hooks });
    await hookedStore.init();

    const task = await hookedStore.create({
      title: "Hooked task",
      createdBy: "main",
      priority: "high",
    });

    await hookedStore.transition(task.frontmatter.id, "ready");
    const readyPath = join(
      tmpDir,
      "views",
      "kanban",
      "priority",
      "high",
      "ready",
      `${task.frontmatter.id}.md`,
    );
    await expect(stat(readyPath)).resolves.toBeDefined();

    await hookedStore.transition(task.frontmatter.id, "in-progress");
    const inProgressPath = join(
      tmpDir,
      "views",
      "kanban",
      "priority",
      "high",
      "in-progress",
      `${task.frontmatter.id}.md`,
    );
    await expect(stat(inProgressPath)).resolves.toBeDefined();
    await expect(stat(readyPath)).rejects.toThrow();
  });
});
