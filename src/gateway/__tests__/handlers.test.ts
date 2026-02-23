import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { AOFMetrics } from "../../metrics/exporter.js";
import { AOFService } from "../../service/aof-service.js";
import { createMetricsHandler, createStatusHandler } from "../handlers.js";

describe("Gateway handlers", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-gateway-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("serves /metrics with scheduler status", async () => {
    const metrics = new AOFMetrics();
    const service = new AOFService({ store, logger }, { dataDir: tmpDir, dryRun: true });

    const handler = createMetricsHandler({ store, metrics, service });
    const response = await handler({ method: "GET", path: "/metrics" });

    expect(response.status).toBe(200);
    expect(response.headers?.["Content-Type"]).toBe(metrics.registry.contentType);
    expect(response.body).toContain("aof_scheduler_up 0");
  });

  it("serves /aof/status with service status", async () => {
    const service = new AOFService({ store, logger }, { dataDir: tmpDir, dryRun: true });
    const handler = createStatusHandler(service);

    const response = await handler({ method: "GET", path: "/aof/status" });
    const body = JSON.parse(response.body) as { running: boolean };

    expect(response.status).toBe(200);
    expect(body.running).toBe(false);
  });

  it("ODD: /aof/status running=true after service start", async () => {
    const service = new AOFService({ store, logger }, { dataDir: tmpDir, dryRun: true });
    const handler = createStatusHandler(service);

    await service.start();

    const response = await handler({ method: "GET", path: "/aof/status" });
    const body = JSON.parse(response.body) as { running: boolean; lastPollAt?: string };

    expect(response.status).toBe(200);
    // ODD: running state reflected in observable status endpoint
    expect(body.running).toBe(true);
    expect(body.lastPollAt).toBeDefined();

    await service.stop();
  });

  it("ODD: /aof/status Content-Type is application/json", async () => {
    const service = new AOFService({ store, logger }, { dataDir: tmpDir, dryRun: true });
    const handler = createStatusHandler(service);

    const response = await handler({ method: "GET", path: "/aof/status" });

    expect(response.headers?.["Content-Type"]).toBe("application/json");
  });

  it("ODD: /metrics reflects task state (aof_tasks_total)", async () => {
    const metrics = new AOFMetrics();
    const service = new AOFService({ store, logger }, { dataDir: tmpDir, dryRun: true });
    const handler = createMetricsHandler({ store, metrics, service });

    // Create and transition tasks
    const task = await store.create({
      title: "Handler metrics task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    const response = await handler({ method: "GET", path: "/metrics" });

    expect(response.status).toBe(200);
    // ODD: metric body includes aof_tasks_total gauge (from collectMetrics)
    expect(response.body).toContain("aof_tasks_total");
  });

  it("ODD: /metrics returns 500 on metrics collection error", async () => {
    const metrics = new AOFMetrics();
    const service = new AOFService({ store, logger }, { dataDir: tmpDir, dryRun: true });

    // Use a store stub that throws to simulate a collection error
    const brokenStore = {
      ...store,
      list: async () => { throw new Error("Store unavailable"); },
    } as unknown as typeof store;

    const handler = createMetricsHandler({ store: brokenStore, metrics, service });
    const response = await handler({ method: "GET", path: "/metrics" });

    // ODD: error path → 500 status with error message
    expect(response.status).toBe(500);
    expect(response.body).toContain("Error:");
  });
});
