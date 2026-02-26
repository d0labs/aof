import { join } from "node:path";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { AOFMetrics } from "../metrics/exporter.js";
import { AOFService } from "../service/aof-service.js";
import { NotificationPolicyEngine, DEFAULT_RULES } from "../events/notification-policy/index.js";
import { ConsoleNotifier } from "../adapters/console-notifier.js";
import { MatrixNotifier } from "./matrix-notifier.js";
import { OpenClawAdapter } from "./openclaw-executor.js";
import { MockAdapter } from "../dispatch/executor.js";
import type { GatewayAdapter } from "../dispatch/executor.js";
import { 
  aofDispatch, 
  aofStatusReport, 
  aofTaskComplete, 
  aofTaskUpdate,
  aofTaskEdit,
  aofTaskCancel,
  aofTaskDepAdd,
  aofTaskDepRemove,
  aofTaskBlock,
  aofTaskUnblock,
} from "../tools/aof-tools.js";
import { createMetricsHandler, createStatusHandler } from "../gateway/handlers.js";
import { loadOrgChart } from "../org/loader.js";
import { PermissionAwareTaskStore } from "../permissions/task-permissions.js";
import type { OrgChart } from "../schemas/org-chart.js";
import type { OpenClawApi } from "./types.js";

export interface AOFPluginOptions {
  dataDir: string;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  dryRun?: boolean;
  maxConcurrentDispatches?: number;
  store?: ITaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  service?: AOFService;
  messageTool?: {
    send(target: string, message: string): Promise<void>;
  };
  orgChartPath?: string;
}

const SERVICE_NAME = "aof-scheduler";

/**
 * Resolve the appropriate GatewayAdapter based on configuration.
 *
 * @param api - OpenClaw API instance
 * @param store - Task store (passed to OpenClawAdapter for heartbeat access)
 * @returns GatewayAdapter implementation
 */
function resolveAdapter(api: OpenClawApi, store: ITaskStore): GatewayAdapter {
  const config = api.config as Record<string, unknown> | undefined;
  const adapterType = (config?.executor as Record<string, unknown>)?.adapter;

  if (adapterType === "mock") {
    return new MockAdapter();
  }

  return new OpenClawAdapter(api, store);
}

export function registerAofPlugin(api: OpenClawApi, opts: AOFPluginOptions): AOFService {
  const store = opts.store ?? new FilesystemTaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(join(opts.dataDir, "events"));
  const metrics = opts.metrics ?? new AOFMetrics();
  
  // Load org chart for permission enforcement (if provided)
  // This will be loaded asynchronously, but we'll handle the undefined case gracefully
  let orgChartPromise: Promise<OrgChart | undefined> | undefined;
  if (opts.orgChartPath) {
    orgChartPromise = loadOrgChart(opts.orgChartPath)
      .then(result => {
        if (result.success && result.chart) {
          return result.chart;
        } else {
          console.warn("Failed to load org chart for permission enforcement:", result.errors);
          return undefined;
        }
      })
      .catch(err => {
        console.warn("Failed to load org chart:", err);
        return undefined;
      });
  }
  
  /**
   * Get a permission-aware store for the given actor.
   * If org chart is not loaded, returns the original store (no permission checks).
   */
  const getStoreForActor = async (actor?: string): Promise<ITaskStore> => {
    if (!orgChartPromise || !actor || actor === "unknown") {
      return store;
    }
    const orgChart = await orgChartPromise;
    if (!orgChart) {
      return store;
    }
    return new PermissionAwareTaskStore(store, orgChart, actor);
  };

  // Build notification adapter: MatrixNotifier (plugin mode) or ConsoleNotifier (standalone)
  const notifAdapter = opts.messageTool
    ? new MatrixNotifier(opts.messageTool)
    : new ConsoleNotifier();
  const engine = new NotificationPolicyEngine(notifAdapter, DEFAULT_RULES);

  // Create executor for agent dispatch (only when explicitly not in dry-run mode)
  const executor = opts.dryRun === false
    ? resolveAdapter(api, store)
    : undefined;

  const service = opts.service
    ?? new AOFService(
      { store, logger, metrics, engine, executor },
      {
        dataDir: opts.dataDir,
        dryRun: opts.dryRun ?? false,
        pollIntervalMs: opts.pollIntervalMs,
        defaultLeaseTtlMs: opts.defaultLeaseTtlMs,
        maxConcurrentDispatches: opts.maxConcurrentDispatches,
      },
    );

  // --- Service (OpenClaw expects `id`, not `name`) ---
  api.registerService({
    id: SERVICE_NAME,
    start: () => service.start(),
    stop: () => service.stop(),
    status: () => service.getStatus(),
  });

  // --- Event hooks ---
  api.on("session_end", () => {
    void service.handleSessionEnd();
  });
  api.on("before_compaction", () => {
    void service.handleSessionEnd();
  });
  api.on("agent_end", (event) => {
    void service.handleAgentEnd(event);
  });
  api.on("message_received", (event) => {
    void service.handleMessageReceived(event);
  });

  // --- Tools ---
  const wrapResult = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  api.registerTool({
    name: "aof_dispatch",
    description: "Create a new AOF task and assign to an agent or team. Returns taskId, status, and filePath.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title (required)" },
        brief: { type: "string", description: "Task description/brief (required)" },
        description: { type: "string", description: "Alias for brief" },
        agent: { type: "string", description: "Agent ID to assign task to" },
        team: { type: "string", description: "Team name for routing" },
        role: { type: "string", description: "Role name for routing" },
        priority: { 
          type: "string", 
          description: "Task priority (critical, high, normal, low)",
          enum: ["critical", "high", "normal", "low"]
        },
        dependsOn: { 
          type: "array", 
          items: { type: "string" },
          description: "Array of task IDs this task depends on"
        },
        parentId: { type: "string", description: "Parent task ID (for subtasks)" },
        metadata: { 
          type: "object", 
          description: "Additional metadata (tags, type, etc.)"
        },
        tags: { 
          type: "array", 
          items: { type: "string" },
          description: "Task tags"
        },
        actor: { type: "string", description: "Agent performing the action" },
      },
      required: ["title", "brief"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofDispatch({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_update",
    description: "Update an AOF task's status/body/work log; use for progress notes, blockers, or outputs on the task card.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to update" },
        status: { type: "string", description: "New status (backlog, ready, in-progress, blocked, review, done)" },
        body: { type: "string", description: "New body content" },
        reason: { type: "string", description: "Reason for transition" },
        actor: { type: "string", description: "Agent performing the update" },
      },
      required: ["taskId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskUpdate({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_status_report",
    description: "Summarize AOF tasks by status/agent; use to check your queue or team workload without scanning task files.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Filter by agent ID" },
        status: { type: "string", description: "Filter by status" },
        actor: { type: "string", description: "Agent requesting the report" },
      },
      required: [],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofStatusReport({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_complete",
    description: `Mark your current task as done.

**When to use:**
- You've finished your work and it's ready for the next step: set outcome to "complete"
- You found problems that need someone else to fix: set outcome to "needs_review" and list blockers
- You can't proceed due to external blockers: set outcome to "blocked" and explain why

**Parameters:**
- outcome (optional): "complete" | "needs_review" | "blocked"
  - "complete": Your work is done and ready to advance (default if omitted)
  - "needs_review": Work needs fixes - include specific blockers
  - "blocked": Can't proceed - external dependency or blocker
  
- summary (optional): Brief description of what you did (1-2 sentences)

- blockers (optional, array of strings): Specific issues that need fixing
  - Required if outcome is "needs_review" or "blocked"
  - Each blocker should be actionable (not vague)
  - Examples: "Missing error handling for expired tokens", "Test coverage at 65%, need 80%"
  
- rejectionNotes (optional, string): Additional context for the person fixing issues
  - Only relevant for "needs_review" outcome
  - Keep it constructive and specific

**Examples:**

Complete (implicit):
{
  "taskId": "AOF-abc",
  "summary": "Implemented JWT middleware with tests, 85% coverage"
}

Complete (explicit):
{
  "taskId": "AOF-abc",
  "outcome": "complete",
  "summary": "Implemented JWT middleware with tests, 85% coverage"
}

Needs Review (reviewer rejecting work):
{
  "taskId": "AOF-abc",
  "outcome": "needs_review",
  "summary": "Implementation needs revision before advancing",
  "blockers": [
    "Missing error handling for expired tokens",
    "Test coverage at 65%, target is 80%"
  ],
  "rejectionNotes": "Please address these issues and resubmit"
}

Blocked (can't proceed):
{
  "taskId": "AOF-abc",
  "outcome": "blocked",
  "summary": "Waiting for API spec from external team",
  "blockers": ["Need finalized API spec from platform team"]
}`,
    parameters: {
      type: "object",
      properties: {
        taskId: { 
          type: "string", 
          description: "Task ID to complete" 
        },
        outcome: {
          type: "string",
          enum: ["complete", "needs_review", "blocked"],
          description: "Result of your work (default: complete)",
        },
        summary: { 
          type: "string", 
          description: "What you did (optional but recommended)" 
        },
        blockers: {
          type: "array",
          items: { type: "string" },
          description: "Specific issues (required for needs_review/blocked)",
        },
        rejectionNotes: {
          type: "string",
          description: "Additional context for needs_review",
        },
        actor: { 
          type: "string", 
          description: "Agent ID (usually auto-populated)" 
        },
      },
      required: ["taskId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskComplete({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_edit",
    description: "Edit task metadata fields (title, description, priority, routing). Use to update task details without changing status.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to edit" },
        title: { type: "string", description: "New task title" },
        description: { type: "string", description: "New task description/body" },
        priority: { 
          type: "string", 
          description: "New priority (critical, high, normal, low)",
          enum: ["critical", "high", "normal", "low"]
        },
        routing: {
          type: "object",
          description: "Update routing fields (agent, team, role, tags)",
          properties: {
            agent: { type: "string", description: "Assigned agent ID" },
            team: { type: "string", description: "Team name" },
            role: { type: "string", description: "Role name" },
            tags: { 
              type: "array", 
              items: { type: "string" },
              description: "Task tags"
            },
          },
        },
        actor: { type: "string", description: "Agent performing the edit" },
      },
      required: ["taskId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskEdit({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_cancel",
    description: "Cancel a task. Moves task to cancelled status and clears any active lease. Use when a task is no longer needed or has become obsolete.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to cancel" },
        reason: { type: "string", description: "Reason for cancellation (optional but recommended)" },
        actor: { type: "string", description: "Agent performing the cancellation" },
      },
      required: ["taskId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskCancel({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_dep_add",
    description: "Add a dependency to a task. Makes taskId depend on blockerId (taskId cannot start until blockerId is done). Validates both tasks exist and prevents circular dependencies.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task that will depend on the blocker" },
        blockerId: { type: "string", description: "Task that must complete first" },
        actor: { type: "string", description: "Agent creating the dependency" },
      },
      required: ["taskId", "blockerId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskDepAdd({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_dep_remove",
    description: "Remove a dependency from a task. Removes the blocker relationship between taskId and blockerId.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task to remove dependency from" },
        blockerId: { type: "string", description: "Blocker task to remove" },
        actor: { type: "string", description: "Agent removing the dependency" },
      },
      required: ["taskId", "blockerId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskDepRemove({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_block",
    description: "Block a task with a reason. Transitions task to blocked state. Use when external dependencies prevent progress. The reason should clearly explain what's blocking the task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to block" },
        reason: { type: "string", description: "Why the task is blocked (required, must be clear and actionable)" },
        actor: { type: "string", description: "Agent blocking the task" },
      },
      required: ["taskId", "reason"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskBlock({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  api.registerTool({
    name: "aof_task_unblock",
    description: "Unblock a task. Transitions task from blocked to ready state. Use when the blocking issue has been resolved.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to unblock" },
        actor: { type: "string", description: "Agent unblocking the task" },
      },
      required: ["taskId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const actor = (params as any).actor;
      const permissionStore = await getStoreForActor(actor);
      const result = await aofTaskUnblock({ store: permissionStore, logger }, params as any);
      return wrapResult(result);
    },
  });

  // --- HTTP routes (use registerHttpRoute for path-based endpoints) ---
  if (typeof api.registerHttpRoute === "function") {
    api.registerHttpRoute({
      path: "/aof/metrics",
      handler: createMetricsHandler({ store, metrics, service }),
    });
    api.registerHttpRoute({
      path: "/aof/status",
      handler: createStatusHandler(service),
    });
  }

  return service;
}
