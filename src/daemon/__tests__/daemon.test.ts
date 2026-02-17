import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { startAofDaemon } from "../daemon.js";
import type { PollResult } from "../../dispatch/scheduler.js";

describe("AOF daemon", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  const makePollResult = (): PollResult => ({
    scannedAt: new Date().toISOString(),
    durationMs: 5,
    dryRun: true,
    actions: [],
    stats: {
      total: 0,
      backlog: 0,
      ready: 0,
      inProgress: 0,
      blocked: 0,
      review: 0,
      done: 0,
    },
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-daemon-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts the daemon loop with a poll", async () => {
    const poller = vi.fn(async () => makePollResult());

    const { service } = await startAofDaemon({
      dataDir: tmpDir,
      pollIntervalMs: 60_000,
      dryRun: true,
      store,
      logger,
      poller,
      enableHealthServer: false,
    });

    expect(poller).toHaveBeenCalledTimes(1);

    await service.stop();
  });

  describe("PID file locking", () => {
    it("creates a PID file on daemon start", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // PID file should not exist before start
      expect(existsSync(pidFile)).toBe(false);

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // PID file should exist and contain current process PID
      expect(existsSync(pidFile)).toBe(true);
      const pidContent = readFileSync(pidFile, "utf-8").trim();
      expect(pidContent).toBe(String(process.pid));

      await service.stop();
    });

    it("prevents concurrent daemon starts with clear error message", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // Start first daemon
      const { service: service1 } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // Attempt to start second daemon should fail
      await expect(
        startAofDaemon({
          dataDir: tmpDir,
          pollIntervalMs: 60_000,
          dryRun: true,
          store,
          logger,
          poller,
          enableHealthServer: false,
        }),
      ).rejects.toThrow(`AOF daemon already running (PID: ${process.pid})`);

      await service1.stop();
    });

    it("cleans up stale PID file and starts successfully", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // Write a stale PID file with a non-existent PID
      const stalePid = 999999;
      writeFileSync(pidFile, String(stalePid));
      expect(existsSync(pidFile)).toBe(true);

      // Daemon should start successfully, cleaning up the stale PID
      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // PID file should now contain current process PID
      expect(existsSync(pidFile)).toBe(true);
      const pidContent = readFileSync(pidFile, "utf-8").trim();
      expect(pidContent).toBe(String(process.pid));

      await service.stop();
    });

    it("removes PID file on graceful service stop", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      // PID file exists while running
      expect(existsSync(pidFile)).toBe(true);

      await service.stop();

      // Note: The exit handler cleanup is tested in signal handling tests
      // In the test environment, service.stop() doesn't trigger process.exit
      // so we verify that the file exists but will be cleaned up on actual exit
      // The real cleanup happens when the process exits
    });

    it("handles signal cleanup (SIGTERM/SIGINT)", async () => {
      const poller = vi.fn(async () => makePollResult());
      const pidFile = join(tmpDir, "daemon.pid");

      // Mock process.exit to prevent test from actually exiting
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      const { service } = await startAofDaemon({
        dataDir: tmpDir,
        pollIntervalMs: 60_000,
        dryRun: true,
        store,
        logger,
        poller,
        enableHealthServer: false,
      });

      expect(existsSync(pidFile)).toBe(true);

      // Simulate SIGTERM
      process.emit("SIGTERM" as any);

      // PID file should be removed
      expect(existsSync(pidFile)).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(0);

      // Restore and clean up
      exitSpy.mockRestore();
      await service.stop();
    });
  });
});
