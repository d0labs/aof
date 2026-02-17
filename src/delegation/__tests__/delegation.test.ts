import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { syncDelegationArtifacts } from "../index.js";

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
});
