import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { acquireLease } from "../../store/lease.js";
import { syncMailboxView, createMailboxHooks } from "../mailbox.js";

const toPosixPath = (value: string) => value.split(sep).join("/");

describe("mailbox view", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-mailbox-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates per-agent inbox/processing/outbox pointers", async () => {
    const inboxTask = await store.create({
      title: "Inbox task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    const inboxReady = await store.transition(inboxTask.frontmatter.id, "ready");

    const processingTask = await store.create({
      title: "Processing task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(processingTask.frontmatter.id, "ready");
    await acquireLease(store, processingTask.frontmatter.id, "swe-backend");

    const outboxTask = await store.create({
      title: "Outbox task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(outboxTask.frontmatter.id, "ready");
    await acquireLease(store, outboxTask.frontmatter.id, "swe-backend");
    const outboxReviewed = await store.transition(outboxTask.frontmatter.id, "review");

    await syncMailboxView(store, { dataDir: tmpDir });

    const inboxPath = join(
      tmpDir,
      "views",
      "mailbox",
      "swe-backend",
      "inbox",
      `${inboxTask.frontmatter.id}.md`,
    );
    const processingPath = join(
      tmpDir,
      "views",
      "mailbox",
      "swe-backend",
      "processing",
      `${processingTask.frontmatter.id}.md`,
    );
    const outboxPath = join(
      tmpDir,
      "views",
      "mailbox",
      "swe-backend",
      "outbox",
      `${outboxTask.frontmatter.id}.md`,
    );

    await expect(stat(inboxPath)).resolves.toBeDefined();
    await expect(stat(processingPath)).resolves.toBeDefined();
    await expect(stat(outboxPath)).resolves.toBeDefined();

    const inboxContents = await readFile(inboxPath, "utf-8");
    const inboxCanonical = toPosixPath(
      relative(join(tmpDir, "views", "mailbox", "swe-backend", "inbox"), inboxReady.path!),
    );
    expect(inboxContents).toContain(`id: ${inboxTask.frontmatter.id}`);
    expect(inboxContents).toContain(`Canonical: ${inboxCanonical}`);

    const outboxContents = await readFile(outboxPath, "utf-8");
    const outboxCanonical = toPosixPath(
      relative(join(tmpDir, "views", "mailbox", "swe-backend", "outbox"), outboxReviewed.path!),
    );
    expect(outboxContents).toContain(`status: review`);
    expect(outboxContents).toContain(`Canonical: ${outboxCanonical}`);
  });

  it("updates pointers on transitions via hooks", async () => {
    let hookedStore: ITaskStore;
    const hooks = createMailboxHooks(() => hookedStore, { dataDir: tmpDir });
    hookedStore = new FilesystemTaskStore(tmpDir, { hooks });
    await hookedStore.init();

    const task = await hookedStore.create({
      title: "Hooked task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });

    await hookedStore.transition(task.frontmatter.id, "ready");
    const inboxPath = join(
      tmpDir,
      "views",
      "mailbox",
      "swe-backend",
      "inbox",
      `${task.frontmatter.id}.md`,
    );
    await expect(stat(inboxPath)).resolves.toBeDefined();

    await acquireLease(hookedStore, task.frontmatter.id, "swe-backend");
    const processingPath = join(
      tmpDir,
      "views",
      "mailbox",
      "swe-backend",
      "processing",
      `${task.frontmatter.id}.md`,
    );
    await expect(stat(processingPath)).resolves.toBeDefined();
    await expect(stat(inboxPath)).rejects.toThrow();
  });
});
