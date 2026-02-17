import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { createAofMcpContext } from "../shared.js";
import { mapWatchEventToUris, SubscriptionManager } from "../subscriptions.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

const createExtra = (send: RequestHandlerExtra<ServerRequest, ServerNotification>["sendNotification"]) => ({
  sessionId: "test",
  sendNotification: send,
} as RequestHandlerExtra<ServerRequest, ServerNotification>);

describe("mcp subscriptions", () => {
  let dataDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aof-mcp-subscriptions-"));
    store = new FilesystemTaskStore(dataDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("maps task file changes to resource URIs", async () => {
    const task = await store.create({
      title: "Task A",
      body: "Body",
      routing: { agent: "swe-backend", team: "swe" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const ctx = await createAofMcpContext({ dataDir, store });
    const path = join(dataDir, "tasks", "ready", `${task.frontmatter.id}.md`);

    const uris = await mapWatchEventToUris(ctx, {
      type: "change",
      path,
      viewType: "kanban",
      timestamp: new Date().toISOString(),
    });

    expect(uris).toContain(`aof://tasks/${task.frontmatter.id}`);
    expect(uris).toContain("aof://tasks?status=ready");
    expect(uris).toContain("aof://views/kanban/swe");
    expect(uris).toContain("aof://views/mailbox/swe-backend");
  });

  it("notifies subscribers on updates", async () => {
    const task = await store.create({
      title: "Task B",
      body: "Body",
      routing: { agent: "swe-backend" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    const ctx = await createAofMcpContext({ dataDir, store });
    const manager = new SubscriptionManager(ctx, { debounceMs: 1 });

    const notifications: Array<{ method: string; params: { uri: string } }> = [];
    const extra = createExtra(async (notification) => {
      notifications.push(notification as any);
    });

    manager.subscribe(`aof://tasks/${task.frontmatter.id}`, extra);

    await manager.handleWatchEvent({
      type: "change",
      path: join(dataDir, "tasks", "ready", `${task.frontmatter.id}.md`),
      viewType: "kanban",
      timestamp: new Date().toISOString(),
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    expect(notifications.some(n => n.params.uri === `aof://tasks/${task.frontmatter.id}`)).toBe(true);
  });
});
