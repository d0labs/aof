import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startWatchdog, type WatchdogConfig } from "../index.js";

describe("Watchdog Plugin", () => {
  let config: WatchdogConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      pollIntervalMs: 100, // Short interval for tests
      healthEndpoint: "http://localhost:13001/health",
      maxRestarts: 3,
      windowMs: 60 * 60 * 1000,
      onAlert: vi.fn(),
      onRestart: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not start if disabled", async () => {
    config.enabled = false;
    const watchdog = await startWatchdog(config);

    expect(watchdog).toBeUndefined();
  });

  it("respects enabled: false config", async () => {
    config.enabled = false;
    const watchdog = await startWatchdog(config);

    expect(watchdog).toBeUndefined();
  });

  it("starts loop if enabled: true", async () => {
    // Mock healthy response
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: "healthy" }),
    });

    const watchdog = await startWatchdog(config);

    expect(watchdog).toBeDefined();
    if (watchdog) {
      await watchdog.stop();
    }
  });

  it("does not restart if health check succeeds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: "healthy" }),
    });

    const watchdog = await startWatchdog(config);

    // Wait for one poll cycle
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(config.onRestart).not.toHaveBeenCalled();

    if (watchdog) {
      await watchdog.stop();
    }
  });
});
