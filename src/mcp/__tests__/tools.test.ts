import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { createAofMcpContext } from "../shared.js";
import {
  handleAofDispatch,
  handleAofStatusReport,
  handleAofTaskComplete,
  handleAofTaskUpdate,
} from "../tools.js";
import { buildBoard } from "../resources.js";

const ORG_CHART = `schemaVersion: 1
teams:
  - id: "swe"
    name: "Software"
agents:
  - id: "swe-backend"
    name: "Backend"
    team: "swe"
  - id: "swe-qa"
    name: "QA"
    team: "swe"
routing: []
metadata: {}
`;

describe("mcp tools", () => {
  let dataDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aof-mcp-tools-"));
    store = new FilesystemTaskStore(dataDir);
    await store.init();
    await mkdir(join(dataDir, "org"), { recursive: true });
    await writeFile(join(dataDir, "org", "org-chart.yaml"), ORG_CHART);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("creates a task via aof_dispatch", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const result = await handleAofDispatch(ctx, {
      title: "Test dispatch",
      brief: "Dispatch a task",
      assignedAgent: "swe-backend",
      priority: "medium",
    });

    const created = await store.get(result.taskId);
    expect(created).toBeDefined();
    expect(created?.frontmatter.status).toBe("ready");
    expect(created?.frontmatter.routing.agent).toBe("swe-backend");
    expect(result.status).toBe("ready");
  });

  it("updates a task via aof_task_update", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Update me",
      body: "Initial body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await handleAofTaskUpdate(ctx, {
      taskId: task.frontmatter.id,
      status: "in-progress",
      workLog: "Started work",
      outputs: ["dist/output.txt"],
    });

    const updated = await store.get(task.frontmatter.id);
    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("in-progress");
    expect(updated?.body).toContain("Work Log");
    expect(updated?.body).toContain("Started work");
    expect(updated?.body).toContain("Outputs");
  });

  it("completes a task via aof_task_complete", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    const task = await store.create({
      title: "Complete me",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");

    const result = await handleAofTaskComplete(ctx, {
      taskId: task.frontmatter.id,
      summary: "Done",
      outputs: ["dist/report.md"],
    });

    const updated = await store.get(task.frontmatter.id);
    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe("done");
    expect(updated?.frontmatter.status).toBe("done");
    expect(updated?.body).toContain("Completion Summary");
  });

  it("returns status report via aof_status_report", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    await store.create({
      title: "Task A",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    const task = await store.create({
      title: "Task B",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const report = await handleAofStatusReport(ctx, {});
    expect(report.total).toBe(2);
    expect(report.byStatus.backlog).toBe(1);
    expect(report.byStatus.ready).toBe(1);
  });

  it("builds a kanban board via aof_board", async () => {
    const ctx = await createAofMcpContext({
      dataDir,
      store,
      logger: new EventLogger(join(dataDir, "events")),
    });

    await store.create({
      title: "Team task",
      body: "Body",
      routing: { team: "swe" },
      createdBy: "test",
    });
    await store.create({
      title: "Other task",
      body: "Body",
      routing: { team: "ops" },
      createdBy: "test",
    });

    const board = await buildBoard(ctx, "swe");
    expect(board.team).toBe("swe");
    expect(board.columns.backlog).toHaveLength(1);
  });
});
