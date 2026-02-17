/**
 * E2E Test Suite 8: Gateway Handlers
 * 
 * Tests gateway endpoint handlers directly (not HTTP):
 * - Status endpoint handler
 * - Metrics endpoint handler
 * - Response format validation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { AOFMetrics } from "../../../src/metrics/exporter.js";
import { AOFService } from "../../../src/service/aof-service.js";
import { createMetricsHandler, createStatusHandler } from "../../../src/gateway/handlers.js";
import type { GatewayRequest } from "../../../src/gateway/handlers.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "gateway-handlers");

describe("E2E: Gateway Handlers", () => {
  let store: ITaskStore;
  let metrics: AOFMetrics;
  let service: AOFService;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    metrics = new AOFMetrics();
    service = new AOFService(
      { store, metrics },
      { dataDir: TEST_DATA_DIR, pollIntervalMs: 60000 }
    );
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("status handler", () => {
    it("should return service status as JSON", async () => {
      const handler = createStatusHandler(service);
      const req: GatewayRequest = {
        method: "GET",
        path: "/status",
      };

      const response = await handler(req);

      expect(response.status).toBe(200);
      expect(response.headers?.["Content-Type"]).toBe("application/json");
      expect(response.body).toBeDefined();

      // Parse and validate JSON
      const status = JSON.parse(response.body);
      expect(status).toHaveProperty("running");
      expect(status).toHaveProperty("pollIntervalMs");
      expect(typeof status.running).toBe("boolean");
      expect(typeof status.pollIntervalMs).toBe("number");
    });

    it("should reflect scheduler running state", async () => {
      const handler = createStatusHandler(service);
      const req: GatewayRequest = {
        method: "GET",
        path: "/status",
      };

      // Initial state (not started)
      const response1 = await handler(req);
      const status1 = JSON.parse(response1.body);
      expect(status1.running).toBe(false);

      // Start service
      await service.start();

      // Check running state
      const response2 = await handler(req);
      const status2 = JSON.parse(response2.body);
      expect(status2.running).toBe(true);

      // Stop service
      await service.stop();

      // Check stopped state
      const response3 = await handler(req);
      const status3 = JSON.parse(response3.body);
      expect(status3.running).toBe(false);
    });

    it("should include poll interval configuration", async () => {
      const handler = createStatusHandler(service);
      const req: GatewayRequest = {
        method: "GET",
        path: "/status",
      };

      const response = await handler(req);
      const status = JSON.parse(response.body);

      expect(status.pollIntervalMs).toBe(60000);
    });
  });

  describe("metrics handler", () => {
    it("should return Prometheus metrics", async () => {
      const handler = createMetricsHandler({ store, metrics, service });
      const req: GatewayRequest = {
        method: "GET",
        path: "/metrics",
      };

      const response = await handler(req);

      expect(response.status).toBe(200);
      expect(response.headers?.["Content-Type"]).toMatch(/^text\/plain/);
      expect(response.body).toContain("aof_tasks_total");
      expect(response.body).toContain("aof_scheduler_up");
    });

    it("should update metrics from current store state", async () => {
      // Create some tasks
      await store.create({
        title: "Test Task 1",
        body: "# Task 1",
        createdBy: "system",
      });

      await store.create({
        title: "Test Task 2",
        body: "# Task 2",
        createdBy: "system",
      });

      const handler = createMetricsHandler({ store, metrics, service });
      const req: GatewayRequest = {
        method: "GET",
        path: "/metrics",
      };

      const response = await handler(req);

      expect(response.status).toBe(200);
      expect(response.body).toContain('state="backlog"');
    });

    it("should include scheduler status in metrics", async () => {
      const handler = createMetricsHandler({ store, metrics, service });
      const req: GatewayRequest = {
        method: "GET",
        path: "/metrics",
      };

      // With scheduler stopped
      const response1 = await handler(req);
      expect(response1.body).toContain("aof_scheduler_up 0");

      // Start scheduler
      await service.start();

      // With scheduler running
      const response2 = await handler(req);
      expect(response2.body).toContain("aof_scheduler_up 1");

      await service.stop();
    });

    it("should handle errors gracefully", async () => {
      // Create handler with null store to trigger error
      const badHandler = createMetricsHandler({
        store: null as any,
        metrics,
        service,
      });
      const req: GatewayRequest = {
        method: "GET",
        path: "/metrics",
      };

      const response = await badHandler(req);

      expect(response.status).toBe(500);
      expect(response.body).toContain("Error:");
    });
  });

  describe("response format validation", () => {
    it("should return valid GatewayResponse shape", async () => {
      const handler = createStatusHandler(service);
      const req: GatewayRequest = {
        method: "GET",
        path: "/status",
      };

      const response = await handler(req);

      // Validate response structure
      expect(response).toHaveProperty("status");
      expect(response).toHaveProperty("body");
      expect(typeof response.status).toBe("number");
      expect(typeof response.body).toBe("string");

      if (response.headers) {
        expect(typeof response.headers).toBe("object");
      }
    });

    it("should set appropriate content-type headers", async () => {
      const statusHandler = createStatusHandler(service);
      const metricsHandler = createMetricsHandler({ store, metrics, service });

      const statusReq: GatewayRequest = { method: "GET", path: "/status" };
      const metricsReq: GatewayRequest = { method: "GET", path: "/metrics" };

      const statusResp = await statusHandler(statusReq);
      const metricsResp = await metricsHandler(metricsReq);

      expect(statusResp.headers?.["Content-Type"]).toBe("application/json");
      expect(metricsResp.headers?.["Content-Type"]).toMatch(/^text\/plain/);
    });

    it("should handle sync and async handlers", async () => {
      // Status handler can be sync or async
      const handler = createStatusHandler(service);
      const req: GatewayRequest = { method: "GET", path: "/status" };

      const response = await handler(req);
      expect(response).toBeDefined();
      expect(response.status).toBe(200);
    });
  });

  describe("integration with real state", () => {
    it("should reflect task operations in metrics endpoint", async () => {
      const handler = createMetricsHandler({ store, metrics, service });
      const req: GatewayRequest = { method: "GET", path: "/metrics" };

      // Create task
      const task = await store.create({
        title: "Integration Test Task",
        body: "# Task",
        createdBy: "system",
      });

      // Fetch metrics
      const response1 = await handler(req);
      expect(response1.body).toContain('state="backlog"');

      // Transition task
      await store.transition(task.frontmatter.id, "ready");

      // Fetch metrics again
      const response2 = await handler(req);
      expect(response2.body).toContain('state="ready"');
    });

    it("should show consistent data across multiple calls", async () => {
      const handler = createMetricsHandler({ store, metrics, service });
      const req: GatewayRequest = { method: "GET", path: "/metrics" };

      // Create fixed state
      await store.create({ title: "Task 1", body: "# T1", createdBy: "system" });
      await store.create({ title: "Task 2", body: "# T2", createdBy: "system" });

      // Call handler twice
      const response1 = await handler(req);
      const response2 = await handler(req);

      // Both should contain the same task counts
      const extractTaskCount = (body: string) => {
        const match = body.match(/aof_tasks_total{agent="all",state="backlog"} (\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      };

      const count1 = extractTaskCount(response1.body);
      const count2 = extractTaskCount(response2.body);

      expect(count1).toBeGreaterThan(0);
      expect(count1).toBe(count2);
    });
  });
});
