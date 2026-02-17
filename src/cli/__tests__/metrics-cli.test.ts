import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { startMetricsServer, AOFMetrics } from "../../metrics/exporter.js";
import { collectMetrics } from "../../metrics/collector.js";
import type { Server } from "node:http";

describe("metrics HTTP server", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let server: Server;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-metrics-cli-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts server and serves /metrics endpoint", async () => {
    const metrics = new AOFMetrics();
    const port = 19090; // High port to avoid conflicts

    server = startMetricsServer(port, metrics, async () => {
      return collectMetrics(store);
    });

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${port}/metrics`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("aof_tasks_total");
    expect(body).toContain("aof_scheduler_up");
  });

  it("serves /health endpoint", async () => {
    const metrics = new AOFMetrics();
    const port = 19091;

    server = startMetricsServer(port, metrics, async () => {
      return collectMetrics(store);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toBe("ok\n");
  });

  it("returns 404 for unknown paths", async () => {
    const metrics = new AOFMetrics();
    const port = 19092;

    server = startMetricsServer(port, metrics, async () => {
      return collectMetrics(store);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${port}/unknown`);
    expect(response.status).toBe(404);
  });

  it("includes live task data in metrics", async () => {
    await store.create({ title: "Task 1", createdBy: "main", priority: "high" });
    await store.create({ title: "Task 2", createdBy: "main", priority: "normal" });

    const metrics = new AOFMetrics();
    const port = 19093;

    server = startMetricsServer(port, metrics, async () => {
      return collectMetrics(store);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${port}/metrics`);
    const body = await response.text();

    expect(body).toContain('aof_tasks_total{agent="all",state="backlog"} 2');
  });
});
