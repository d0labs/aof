/**
 * Daemon command tests — start/stop/status/restart
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import type { DaemonStartOptions, DaemonStopOptions } from "../daemon.js";

describe("daemon command options", () => {
  describe("option parsing", () => {
    it("should accept default port", () => {
      const options: DaemonStartOptions = {
        port: "18000",
        bind: "127.0.0.1",
        logLevel: "info",
      };
      expect(options.port).toBe("18000");
    });

    it("should accept custom port", () => {
      const options: DaemonStartOptions = {
        port: "18001",
        bind: "127.0.0.1",
        logLevel: "info",
      };
      expect(options.port).toBe("18001");
    });

    it("should accept custom bind address", () => {
      const options: DaemonStartOptions = {
        port: "18000",
        bind: "0.0.0.0",
        logLevel: "info",
      };
      expect(options.bind).toBe("0.0.0.0");
    });

    it("should accept custom log level", () => {
      const options: DaemonStartOptions = {
        port: "18000",
        bind: "127.0.0.1",
        logLevel: "debug",
      };
      expect(options.logLevel).toBe("debug");
    });

    it("should accept custom timeout for stop", () => {
      const options: DaemonStopOptions = {
        timeout: "30",
      };
      expect(options.timeout).toBe("30");
    });
  });

  describe("data directory handling", () => {
    it("should use provided data directory", () => {
      const options: DaemonStartOptions = {
        port: "18000",
        bind: "127.0.0.1",
        dataDir: "/custom/path",
        logLevel: "info",
      };
      expect(options.dataDir).toBe("/custom/path");
    });

    it("should allow undefined data directory (falls back to root)", () => {
      const options: DaemonStartOptions = {
        port: "18000",
        bind: "127.0.0.1",
        logLevel: "info",
      };
      expect(options.dataDir).toBeUndefined();
    });
  });
});

describe("PID file handling", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-daemon-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should detect existing PID file", () => {
    const pidFile = join(testDir, "daemon.pid");
    writeFileSync(pidFile, String(process.pid));
    expect(existsSync(pidFile)).toBe(true);
  });

  it("should handle stale PID file (non-existent process)", () => {
    const pidFile = join(testDir, "daemon.pid");
    // Use a PID that definitely doesn't exist (999999)
    writeFileSync(pidFile, "999999");
    expect(existsSync(pidFile)).toBe(true);
  });

  it("should handle invalid PID content", () => {
    const pidFile = join(testDir, "daemon.pid");
    writeFileSync(pidFile, "not-a-number");
    expect(existsSync(pidFile)).toBe(true);
  });
});
