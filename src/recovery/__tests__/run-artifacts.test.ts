import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { acquireLease } from "../../store/lease.js";
import {
  writeRunArtifact,
  readRunArtifact,
  writeHeartbeat,
  readHeartbeat,
  checkStaleHeartbeats,
  getResumeInfo,
  writeRunResult,
  readRunResult,
} from "../run-artifacts.js";

describe("run artifacts", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-run-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("run.json", () => {
    it("writes and reads run artifact", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");

      await writeRunArtifact(store, task.frontmatter.id, "test-agent");

      const run = await readRunArtifact(store, task.frontmatter.id);
      expect(run).toBeDefined();
      expect(run!.taskId).toBe(task.frontmatter.id);
      expect(run!.agentId).toBe("test-agent");
      expect(run!.status).toBe("running");
      expect(run!.startedAt).toBeDefined();
    });

    it("returns undefined for missing run.json", async () => {
      const task = await store.create({ title: "No run", createdBy: "main" });
      const run = await readRunArtifact(store, task.frontmatter.id);
      expect(run).toBeUndefined();
    });

    it("includes default artifact paths", async () => {
      const task = await store.create({
        title: "Artifact paths",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");

      await writeRunArtifact(store, task.frontmatter.id, "test-agent");
      const run = await readRunArtifact(store, task.frontmatter.id);

      expect(run!.artifactPaths.inputs).toBe("inputs/");
      expect(run!.artifactPaths.work).toBe("work/");
      expect(run!.artifactPaths.output).toBe("output/");
    });
  });

  describe("heartbeat", () => {
    it("writes and reads heartbeat", async () => {
      const task = await store.create({
        title: "Heartbeat task",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      // acquireLease now writes initial heartbeat (beatCount = 0)
      await acquireLease(store, task.frontmatter.id, "test-agent");

      // Renew heartbeat (beatCount = 1)
      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 300_000);

      const heartbeat = await readHeartbeat(store, task.frontmatter.id);
      expect(heartbeat).toBeDefined();
      expect(heartbeat!.taskId).toBe(task.frontmatter.id);
      expect(heartbeat!.agentId).toBe("test-agent");
      expect(heartbeat!.beatCount).toBe(1);
      expect(heartbeat!.expiresAt).toBeDefined();
    });

    it("increments beat count on renewal", async () => {
      const task = await store.create({
        title: "Beat count",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      // acquireLease writes initial heartbeat (beatCount = 0)
      await acquireLease(store, task.frontmatter.id, "test-agent");

      // Two renewals → beatCount = 2
      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 300_000);
      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 300_000);

      const heartbeat = await readHeartbeat(store, task.frontmatter.id);
      expect(heartbeat!.beatCount).toBe(2);
    });

    it("returns undefined for missing heartbeat", async () => {
      const task = await store.create({ title: "No heartbeat", createdBy: "main" });
      const heartbeat = await readHeartbeat(store, task.frontmatter.id);
      expect(heartbeat).toBeUndefined();
    });
  });

  describe("stale detection", () => {
    it("detects expired heartbeats", async () => {
      const task = await store.create({
        title: "Stale task",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");

      // Write heartbeat with 1ms TTL
      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const stale = await checkStaleHeartbeats(store, 1);
      expect(stale).toHaveLength(1);
      expect(stale[0]?.taskId).toBe(task.frontmatter.id);
    });

    it("does not flag fresh heartbeats", async () => {
      const task = await store.create({
        title: "Fresh task",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");

      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 300_000);

      const stale = await checkStaleHeartbeats(store, 300_000);
      expect(stale).toHaveLength(0);
    });
  });

  describe("resume info", () => {
    it("returns resumable status for valid run with fresh heartbeat", async () => {
      const task = await store.create({
        title: "Resumable",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");

      await writeRunArtifact(store, task.frontmatter.id, "test-agent");
      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 300_000);

      const info = await getResumeInfo(store, task.frontmatter.id, 300_000);
      expect(info.status).toBe("resumable");
      expect(info.runArtifact).toBeDefined();
      expect(info.heartbeat).toBeDefined();
    });

    it("returns stale status for expired heartbeat", async () => {
      const task = await store.create({
        title: "Stale",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");

      await writeRunArtifact(store, task.frontmatter.id, "test-agent");
      await writeHeartbeat(store, task.frontmatter.id, "test-agent", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const info = await getResumeInfo(store, task.frontmatter.id, 1);
      expect(info.status).toBe("stale");
    });

    it("returns completed status for done tasks", async () => {
      const task = await store.create({
        title: "Completed",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "test-agent");
      await store.transition(task.frontmatter.id, "review");
      await store.transition(task.frontmatter.id, "done");

      const info = await getResumeInfo(store, task.frontmatter.id, 300_000);
      expect(info.status).toBe("completed");
    });
  });

  describe("run_result.json", () => {
    it("writes and reads run result", async () => {
      const task = await store.create({
        title: "Run result",
        createdBy: "main",
        routing: { agent: "test-agent" },
      });

      const result = {
        taskId: task.frontmatter.id,
        agentId: "test-agent",
        completedAt: "2026-02-09T21:10:00.000Z",
        outcome: "partial",
        summaryRef: "outputs/summary.md",
        handoffRef: "outputs/handoff.md",
        deliverables: ["src/foo.ts"],
        tests: { total: 1, passed: 1, failed: 0 },
        blockers: ["Awaiting API key"],
        notes: "Implemented core logic",
      };

      await writeRunResult(store, task.frontmatter.id, result);

      const readResult = await readRunResult(store, task.frontmatter.id);
      expect(readResult).toBeDefined();
      expect(readResult!.taskId).toBe(task.frontmatter.id);
      expect(readResult!.outcome).toBe("partial");
    });

    it("returns undefined for missing run_result.json", async () => {
      const task = await store.create({ title: "No run result", createdBy: "main" });
      const result = await readRunResult(store, task.frontmatter.id);
      expect(result).toBeUndefined();
    });

    it("returns undefined for corrupt run_result.json", async () => {
      const task = await store.create({ title: "Corrupt run result", createdBy: "main" });
      const runsDir = join(store.projectRoot, "state", "runs", task.frontmatter.id);
      await mkdir(runsDir, { recursive: true });
      await writeFile(join(runsDir, "run_result.json"), "{not-json");

      const result = await readRunResult(store, task.frontmatter.id);
      expect(result).toBeUndefined();
    });
  });
});
