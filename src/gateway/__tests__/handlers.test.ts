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
});
