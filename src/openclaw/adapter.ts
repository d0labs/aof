import { join } from "node:path";
import { TaskStore } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import { AOFMetrics } from "../metrics/exporter.js";
import { AOFService } from "../service/aof-service.js";
import { NotificationService } from "../events/notifier.js";
import { MatrixNotifier } from "./matrix-notifier.js";
import { OpenClawExecutor } from "./openclaw-executor.js";
import { aofDispatch, aofStatusReport, aofTaskComplete, aofTaskUpdate } from "../tools/aof-tools.js";
import { createMetricsHandler, createStatusHandler } from "../gateway/handlers.js";
import type { OpenClawApi } from "./types.js";

export interface AOFPluginOptions {
  dataDir: string;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  dryRun?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
  maxConcurrentDispatches?: number;
  store?: TaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  service?: AOFService;
  messageTool?: {
    send(target: string, message: string): Promise<void>;
  };
}

const SERVICE_NAME = "aof-scheduler";

export function registerAofPlugin(api: OpenClawApi, opts: AOFPluginOptions): AOFService {
  const store = opts.store ?? new TaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(join(opts.dataDir, "events"));
  const metrics = opts.metrics ?? new AOFMetrics();

  // Wire up notification service if message tool provided
  let notifier: NotificationService | undefined;
  if (opts.messageTool) {
    const adapter = new MatrixNotifier(opts.messageTool);
    notifier = new NotificationService(adapter, { enabled: true });
  }

  // Create executor for agent dispatch (only when explicitly not in dry-run mode)
  const executor = opts.dryRun === false 
    ? new OpenClawExecutor(api, {
        gatewayUrl: opts.gatewayUrl,
        gatewayToken: opts.gatewayToken,
      })
    : undefined;

  const service = opts.service
    ?? new AOFService(
      { store, logger, metrics, notifier, executor },
      {
        dataDir: opts.dataDir,
        dryRun: opts.dryRun ?? true,
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
      const result = await aofDispatch({ store, logger }, params as any);
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
      const result = await aofTaskUpdate({ store, logger }, params as any);
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
      },
      required: [],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = await aofStatusReport({ store, logger }, params as any);
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
      const result = await aofTaskComplete({ store, logger }, params as any);
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
