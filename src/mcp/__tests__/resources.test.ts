import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { createAofMcpContext } from "../shared.js";
import {
  readTaskResource,
  readTasksByStatusResource,
  readKanbanResource,
  readMailboxResource,
  readOrgChartResource,
} from "../resources.js";

const ORG_CHART = `schemaVersion: 1
teams:
  - id: "swe"
    name: "Software"
agents:
  - id: "swe-backend"
    name: "Backend"
    team: "swe"
routing: []
metadata: {}
`;

describe("mcp resources", () => {
  let dataDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aof-mcp-resources-"));
    store = new FilesystemTaskStore(dataDir);
    await store.init();
    await mkdir(join(dataDir, "org"), { recursive: true });
    await writeFile(join(dataDir, "org", "org-chart.yaml"), ORG_CHART);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reads task resource", async () => {
    const task = await store.create({
      title: "Task A",
      body: "Body",
      routing: { agent: "swe-backend", team: "swe" },
      createdBy: "test",
    });

    const ctx = await createAofMcpContext({ dataDir, store });
    const result = await readTaskResource(ctx, task.frontmatter.id);
    const payload = JSON.parse(result.contents[0]!.text);

    expect(payload.id).toBe(task.frontmatter.id);
    expect(payload.assignedAgent).toBe("swe-backend");
  });

  it("reads tasks by status resource", async () => {
    const task = await store.create({
      title: "Task B",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const ctx = await createAofMcpContext({ dataDir, store });
    const uri = new URL("aof://tasks?status=ready");
    const result = await readTasksByStatusResource(ctx, uri);
    const payload = JSON.parse(result.contents[0]!.text);

    expect(payload.status).toBe("ready");
    expect(payload.tasks).toHaveLength(1);
  });

  it("reads kanban resource", async () => {
    await store.create({
      title: "Task C",
      body: "Body",
      routing: { team: "swe" },
      createdBy: "test",
    });

    const ctx = await createAofMcpContext({ dataDir, store });
    const uri = new URL("aof://views/kanban/swe");
    const result = await readKanbanResource(ctx, "swe", uri);
    const payload = JSON.parse(result.contents[0]!.text);

    expect(payload.team).toBe("swe");
    expect(payload.columns.backlog).toHaveLength(1);
  });

  it("reads mailbox resource", async () => {
    const task = await store.create({
      title: "Task D",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const reviewTask = await store.create({
      title: "Task E",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(reviewTask.frontmatter.id, "ready");
    await store.transition(reviewTask.frontmatter.id, "in-progress");
    await store.transition(reviewTask.frontmatter.id, "review");

    const ctx = await createAofMcpContext({ dataDir, store });
    const uri = new URL("aof://views/mailbox/swe-backend");
    const result = await readMailboxResource(ctx, "swe-backend", uri);
    const payload = JSON.parse(result.contents[0]!.text);

    expect(payload.inbox).toHaveLength(1);
    expect(payload.outbox).toHaveLength(1);
  });

  it("reads org chart resource", async () => {
    const ctx = await createAofMcpContext({ dataDir, store });
    const uri = new URL("aof://org/chart");
    const result = await readOrgChartResource(ctx, uri);
    const payload = JSON.parse(result.contents[0]!.text);

    expect(payload.schemaVersion).toBe(1);
    expect(payload.teams).toHaveLength(1);
  });
});
