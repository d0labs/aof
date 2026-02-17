import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import plugin from "../../plugin.js";
import * as adapter from "../adapter.js";
import type { OpenClawApi } from "../types.js";

type Registry = {
  serviceIds: string[];
  toolNames: string[];
  toolOptionals: boolean[];
  httpRoutes: string[];
  events: string[];
};

const createStrictApi = (overrides: Partial<OpenClawApi> = {}) => {
  const registry: Registry = {
    serviceIds: [],
    toolNames: [],
    toolOptionals: [],
    httpRoutes: [],
    events: [],
  };

  const api: OpenClawApi = {
    registerService: (service) => {
      const id = service.id.trim();
      registry.serviceIds.push(id);
    },
    registerTool: (tool, opts) => {
      const names = opts?.names ?? (opts?.name ? [opts.name] : []);
      if (typeof tool !== "function") names.push(tool.name);
      const normalized = names.map((name) => name.trim()).filter(Boolean);
      registry.toolNames.push(...normalized);
      registry.toolOptionals.push(opts?.optional === true);
    },
    registerHttpRoute: (params) => {
      const trimmed = params.path.trim();
      if (!trimmed) return;
      const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
      registry.httpRoutes.push(normalized);
    },
    on: (event) => {
      registry.events.push(event);
    },
    ...overrides,
  };

  return { api, registry };
};

const DEFAULT_DATA_DIR = join(homedir(), ".openclaw", "aof");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AOF OpenClaw plugin entrypoint", () => {
  it("registers with strict OpenClaw API behavior and forwards config", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api, registry } = createStrictApi({
      pluginConfig: {
        dataDir: "/tmp/aof",
        pollIntervalMs: 15_000,
        defaultLeaseTtlMs: 123_000,
        dryRun: false,
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: "/tmp/aof",
      pollIntervalMs: 15_000,
      defaultLeaseTtlMs: 123_000,
      dryRun: false,
    });

    expect(registry.serviceIds).toEqual(["aof-scheduler"]);
    expect(registry.toolNames).toEqual([
      "aof_dispatch",
      "aof_task_update",
      "aof_status_report",
      "aof_task_complete",
      "aof_task_edit",
      "aof_task_cancel",
      "aof_task_dep_add",
      "aof_task_dep_remove",
      "aof_task_block",
      "aof_task_unblock",
    ]);
    expect(registry.toolOptionals).toEqual([false, false, false, false, false, false, false, false, false, false]);
    expect(registry.httpRoutes).toEqual(["/aof/metrics", "/aof/status"]);
    expect(registry.events).toEqual(
      expect.arrayContaining(["session_end", "before_compaction", "agent_end", "message_received"]),
    );
  });

  it("defaults config when missing", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi();

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: DEFAULT_DATA_DIR,
      pollIntervalMs: 30_000,
      defaultLeaseTtlMs: 300_000,
      dryRun: true,
    });
  });

  it("falls back to defaults when dataDir is blank", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi({
      pluginConfig: {
        dataDir: "   ",
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: DEFAULT_DATA_DIR,
    });
  });

  it("expands tilde in dataDir", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi({
      pluginConfig: {
        dataDir: "~/.openclaw/aof",
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      dataDir: DEFAULT_DATA_DIR,
    });
  });

  it("forwards gatewayUrl and gatewayToken from plugin config", () => {
    const spy = vi.spyOn(adapter, "registerAofPlugin");
    const { api } = createStrictApi({
      pluginConfig: {
        dataDir: "/tmp/aof",
        gatewayUrl: "http://127.0.0.1:18789",
        gatewayToken: "test-token-123",
        dryRun: false,
      },
    });

    plugin.register(api);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });
  });
});
