import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { syncDelegationArtifacts } from "../index.js";
import type { DelegationSyncResult } from "../index.js";

const toPosixPath = (value: string) => value.split(sep).join("/");

describe("delegation artifacts", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-delegation-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates subtask pointers and handoff files", async () => {
    const parent = await store.create({ title: "Parent task", createdBy: "main" });
    const child = await store.create({
      title: "Child task",
      createdBy: "main",
      parentId: parent.frontmatter.id,
    });

    await store.transition(parent.frontmatter.id, "ready");
    await store.transition(child.frontmatter.id, "ready");

    await syncDelegationArtifacts(store);

    const subtaskPath = join(
      tmpDir,
      "tasks",
      "ready",
      parent.frontmatter.id,
      "subtasks",
      `${child.frontmatter.id}.md`,
    );
    const handoffPath = join(
      tmpDir,
      "tasks",
      "ready",
      child.frontmatter.id,
      "handoff.md",
    );

    await expect(stat(subtaskPath)).resolves.toBeDefined();
    await expect(stat(handoffPath)).resolves.toBeDefined();

    const subtaskContents = await readFile(subtaskPath, "utf-8");
    const handoffRel = toPosixPath(
      relative(
        join(tmpDir, "tasks", "ready", parent.frontmatter.id, "subtasks"),
        handoffPath,
      ),
    );
    expect(subtaskContents).toContain(`parentId: ${parent.frontmatter.id}`);
    expect(subtaskContents).toContain(`Handoff: ${handoffRel}`);

    const handoffContents = await readFile(handoffPath, "utf-8");
    const parentTaskRel = toPosixPath(
      relative(
        join(tmpDir, "tasks", "ready", child.frontmatter.id),
        join(tmpDir, "tasks", "ready", `${parent.frontmatter.id}.md`),
      ),
    );
    expect(handoffContents).toContain(`Parent: ${parentTaskRel}`);
    expect(handoffContents).toContain("Output: output");
  });

  it("ODD result: syncDelegationArtifacts returns pointer and handoff counts", async () => {
    const parent = await store.create({ title: "Parent task", createdBy: "main" });
    const child = await store.create({
      title: "Child task",
      createdBy: "main",
      parentId: parent.frontmatter.id,
    });

    await store.transition(parent.frontmatter.id, "ready");
    await store.transition(child.frontmatter.id, "ready");

    const result: DelegationSyncResult = await syncDelegationArtifacts(store);

    // ODD: return value is the observable signal of sync outcome
    expect(result.pointerCount).toBe(1);
    expect(result.handoffCount).toBe(1);
    expect(result.parents).toContain(parent.frontmatter.id);
  });

  it("ODD filesystem: multiple children produce individual subtask pointers", async () => {
    const parent = await store.create({ title: "Parent task", createdBy: "main" });
    const children = [];
    for (let i = 0; i < 3; i++) {
      const child = await store.create({
        title: `Child ${i + 1}`,
        createdBy: "main",
        parentId: parent.frontmatter.id,
      });
      await store.transition(child.frontmatter.id, "ready");
      children.push(child);
    }
    await store.transition(parent.frontmatter.id, "ready");

    const result = await syncDelegationArtifacts(store);

    // ODD result: 3 pointers, 3 handoffs
    expect(result.pointerCount).toBe(3);
    expect(result.handoffCount).toBe(3);

    // ODD filesystem: each child has a pointer file in parent's subtasks dir
    const parentDir = join(tmpDir, "tasks", "ready", parent.frontmatter.id, "subtasks");
    for (const child of children) {
      const pointerPath = join(parentDir, `${child.frontmatter.id}.md`);
      await expect(stat(pointerPath)).resolves.toBeDefined();
    }
  });

  it("ODD filesystem: independent task produces no subtask artifacts", async () => {
    const independent = await store.create({ title: "Standalone task", createdBy: "main" });
    await store.transition(independent.frontmatter.id, "ready");

    const result = await syncDelegationArtifacts(store);

    // ODD: no pointers for tasks without a parentId
    expect(result.pointerCount).toBe(0);
    expect(result.handoffCount).toBe(0);
    expect(result.parents).toHaveLength(0);
  });

  it("ODD filesystem: child pointer includes parentId in content", async () => {
    const parent = await store.create({ title: "Parent", createdBy: "main" });
    const child = await store.create({
      title: "Child",
      createdBy: "main",
      parentId: parent.frontmatter.id,
    });
    await store.transition(parent.frontmatter.id, "ready");
    await store.transition(child.frontmatter.id, "ready");

    await syncDelegationArtifacts(store);

    const pointerPath = join(
      tmpDir, "tasks", "ready", parent.frontmatter.id,
      "subtasks", `${child.frontmatter.id}.md`
    );
    const contents = await readFile(pointerPath, "utf-8");
    // ODD filesystem: pointer references parent ID for traceability
    expect(contents).toContain(`parentId: ${parent.frontmatter.id}`);
  });
});
