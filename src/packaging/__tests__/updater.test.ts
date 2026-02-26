import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selfUpdate, rollbackUpdate, type UpdateOptions, type UpdateHooks } from "../updater.js";

/**
 * Create a real tar.gz buffer for use in mocked fetch responses.
 * The tarball contains a minimal package.json so extractTarball() succeeds.
 */
function createTestTarball(): Buffer {
  const staging = mkdtempSync(join(tmpdir(), "aof-test-tarball-"));
  writeFileSync(join(staging, "package.json"), '{"name":"aof","version":"0.0.0-test"}');
  const tarPath = join(staging, "test.tar.gz");
  execSync(`tar -czf "${tarPath}" -C "${staging}" package.json`);
  const buf = readFileSync(tarPath);
  execSync(`rm -rf "${staging}"`);
  return buf;
}

function mockTarballResponse(tarballData: Buffer) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(tarballData));
      controller.close();
    },
  });
  return {
    ok: true,
    body: stream,
    arrayBuffer: async () => tarballData.buffer,
  };
}

describe("Self-Update Engine", () => {
  let tmpDir: string;
  let aofRoot: string;
  let mockFetch: ReturnType<typeof vi.fn>;
  let realTarball: Buffer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-updater-test-"));
    aofRoot = join(tmpDir, "aof");
    realTarball = createTestTarball();

    // Create AOF directory structure
    await mkdir(aofRoot, { recursive: true });
    await mkdir(join(aofRoot, ".aof"), { recursive: true });
    await mkdir(join(aofRoot, "config"), { recursive: true });
    await mkdir(join(aofRoot, "data"), { recursive: true });

    // Create channel config
    await writeFile(
      join(aofRoot, ".aof", "channel.json"),
      JSON.stringify({
        channel: "stable",
        version: "1.0.0",
      }, null, 2),
    );

    // Create sample config/data files
    await writeFile(join(aofRoot, "config", "settings.json"), JSON.stringify({ test: true }));
    await writeFile(join(aofRoot, "data", "state.json"), JSON.stringify({ count: 42 }));

    // Mock fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("selfUpdate()", () => {
    it("downloads and installs new version successfully", async () => {
      mockFetch.mockResolvedValueOnce(mockTarballResponse(realTarball));

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        preservePaths: ["config", "data"],
      };

      const result = await selfUpdate(opts);

      expect(result.success).toBe(true);
      expect(result.version).toBe("1.1.0");
      expect(result.backupCreated).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/aof-1.1.0.tar.gz",
        expect.any(Object),
      );

      // Verify version updated in config
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.1.0");
    });

    it("preserves config and data during update", async () => {
      mockFetch.mockResolvedValueOnce(mockTarballResponse(realTarball));

      const originalConfig = await readFile(join(aofRoot, "config", "settings.json"), "utf-8");
      const originalData = await readFile(join(aofRoot, "data", "state.json"), "utf-8");

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        preservePaths: ["config", "data"],
      };

      await selfUpdate(opts);

      // Verify config and data preserved
      const newConfig = await readFile(join(aofRoot, "config", "settings.json"), "utf-8");
      const newData = await readFile(join(aofRoot, "data", "state.json"), "utf-8");

      expect(newConfig).toBe(originalConfig);
      expect(newData).toBe(originalData);
    });

    it("executes pre-update hooks", async () => {
      mockFetch.mockResolvedValueOnce(mockTarballResponse(realTarball));

      const preUpdateMock = vi.fn().mockResolvedValue(undefined);
      const hooks: UpdateHooks = {
        preUpdate: preUpdateMock,
      };

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        hooks,
      };

      await selfUpdate(opts);

      expect(preUpdateMock).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        aofRoot,
      });
    });

    it("executes post-update hooks", async () => {
      mockFetch.mockResolvedValueOnce(mockTarballResponse(realTarball));

      const postUpdateMock = vi.fn().mockResolvedValue(undefined);
      const hooks: UpdateHooks = {
        postUpdate: postUpdateMock,
      };

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        hooks,
      };

      await selfUpdate(opts);

      expect(postUpdateMock).toHaveBeenCalledWith({
        previousVersion: "1.0.0",
        currentVersion: "1.1.0",
        aofRoot,
      });
    });

    it("rolls back on download failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        preservePaths: ["config", "data"],
      };

      await expect(selfUpdate(opts)).rejects.toThrow(/download failed/i);

      // Verify original version still in config
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.0.0");
    });

    it("rolls back on health check failure", async () => {
      mockFetch.mockResolvedValueOnce(mockTarballResponse(realTarball));

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        healthCheck: async () => false, // Fail health check
      };

      await expect(selfUpdate(opts)).rejects.toThrow(/health check failed/i);

      // Verify rollback restored original version
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.0.0");
    });

    it("respects timeout", async () => {
      // Mock fetch that respects the abort signal
      mockFetch.mockImplementationOnce((url: string, options: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
          // Never resolve unless aborted
        });
      });

      const opts: UpdateOptions = {
        aofRoot,
        targetVersion: "1.1.0",
        downloadUrl: "https://example.com/aof-1.1.0.tar.gz",
        timeoutMs: 100,
      };

      await expect(selfUpdate(opts)).rejects.toThrow(/timeout|timed out/i);
    });
  });

  describe("rollbackUpdate()", () => {
    it("restores previous version from backup", async () => {
      // Simulate a successful update first
      const backupPath = join(aofRoot, ".aof-backup", "backup-test");
      await mkdir(join(backupPath, ".aof"), { recursive: true });
      await mkdir(join(backupPath, "config"), { recursive: true });
      await writeFile(
        join(backupPath, ".aof", "channel.json"),
        JSON.stringify({ channel: "stable", version: "1.0.0" }, null, 2),
      );
      await writeFile(
        join(backupPath, "config", "settings.json"),
        JSON.stringify({ original: true }),
      );

      // Update current version
      await writeFile(
        join(aofRoot, ".aof", "channel.json"),
        JSON.stringify({ channel: "stable", version: "1.1.0" }, null, 2),
      );
      await writeFile(
        join(aofRoot, "config", "settings.json"),
        JSON.stringify({ modified: true }),
      );

      // Rollback
      const result = await rollbackUpdate({
        aofRoot,
        backupPath,
        preservePaths: ["config", ".aof"],
      });

      expect(result.success).toBe(true);
      expect(result.restoredVersion).toBe("1.0.0");

      // Verify version restored
      const config = JSON.parse(
        await readFile(join(aofRoot, ".aof", "channel.json"), "utf-8"),
      );
      expect(config.version).toBe("1.0.0");

      // Verify config restored
      const settings = JSON.parse(
        await readFile(join(aofRoot, "config", "settings.json"), "utf-8"),
      );
      expect(settings.original).toBe(true);
    });

    it("fails when backup doesn't exist", async () => {
      const nonExistentBackup = join(aofRoot, ".aof-backup", "nonexistent");

      await expect(
        rollbackUpdate({
          aofRoot,
          backupPath: nonExistentBackup,
          preservePaths: ["config"],
        }),
      ).rejects.toThrow(/backup not found/i);
    });
  });
});

describe("extractTarball integration", () => {
  it("should extract a tar.gz archive correctly", () => {
    // Create a temp tarball mimicking build-tarball.mjs output
    const tmpDir = mkdtempSync(join(tmpdir(), "aof-extract-test-"));
    const stagingDir = join(tmpDir, "staging");
    mkdirSync(stagingDir, { recursive: true });

    // Create test files matching tarball structure
    writeFileSync(join(stagingDir, "package.json"), '{"name":"aof","version":"0.1.0"}');
    mkdirSync(join(stagingDir, "dist"), { recursive: true });
    writeFileSync(join(stagingDir, "dist", "index.js"), "console.log('aof');");

    // Create tarball (same way as build-tarball.mjs: -C staging .)
    const tarballPath = join(tmpDir, "aof-test.tar.gz");
    execSync(`tar -czf "${tarballPath}" -C "${stagingDir}" .`);

    // Extract to new directory
    const extractDir = join(tmpDir, "extracted");
    mkdirSync(extractDir, { recursive: true });
    execSync(`tar -xzf "${tarballPath}" -C "${extractDir}"`);

    // Verify
    const pkg = JSON.parse(readFileSync(join(extractDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("aof");
    expect(pkg.version).toBe("0.1.0");

    const index = readFileSync(join(extractDir, "dist", "index.js"), "utf-8");
    expect(index).toBe("console.log('aof');");

    // Cleanup
    execSync(`rm -rf "${tmpDir}"`);
  });
});
