/**
 * Prometheus metrics exporter for AOF using prom-client.
 *
 * Serves metrics at /metrics endpoint.
 * Uses the standard prom-client library for correct exposition format.
 *
 * Metrics (per FR-7.1):
 * - aof_tasks_total{agent,state}                    gauge
 * - aof_delegation_events_total{from_agent,to_agent} counter
 * - aof_org_chart_mutations_total{mutation_type}     counter
 * - aof_scheduler_loop_duration_seconds              histogram
 * - aof_task_staleness_seconds{agent,task_id}        gauge
 * - aof_lock_acquisition_failures_total              counter
 * - aof_scheduler_up                                 gauge
 * - aof_scheduler_poll_failures_total                counter
 * - aof_context_bundle_chars{taskId,agentId}         gauge
 * - aof_context_bundle_tokens{taskId,agentId}        gauge
 * - aof_context_budget_status{taskId,status}         counter
 * - aof_agent_context_bytes{agentId}                 gauge
 * - aof_agent_context_tokens{agentId}                gauge
 */

import { createServer, type Server } from "node:http";
import {
  Registry,
  Gauge,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";

export interface MetricsState {
  tasksByStatus: Record<string, number>;
  tasksByAgentAndStatus: Array<{ agent: string; status: string; count: number }>;
  staleTasks: Array<{ agent: string; taskId: string; stalenessSeconds: number }>;
  schedulerUp: boolean;
}

/**
 * AOF Metrics registry — all metrics in one place.
 */
export class AOFMetrics {
  readonly registry: Registry;

  readonly tasksTotal: Gauge;
  readonly delegationEventsTotal: Counter;
  readonly orgChartMutationsTotal: Counter;
  readonly schedulerLoopDuration: Histogram;
  readonly taskStaleness: Gauge;
  readonly lockAcquisitionFailures: Counter;
  readonly schedulerUp: Gauge;
  readonly schedulerPollFailures: Counter;
  readonly contextBundleChars: Gauge;
  readonly contextBundleTokens: Gauge;
  readonly contextBudgetStatus: Counter;
  readonly agentContextBytes: Gauge;
  readonly agentContextTokens: Gauge;

  // Gate telemetry metrics
  readonly gateDuration: Histogram;
  readonly gateTransitionsTotal: Counter;
  readonly gateRejectionsTotal: Counter;
  readonly gateTimeoutsTotal: Counter;
  readonly gateEscalationsTotal: Counter;

  constructor() {
    this.registry = new Registry();

    // Collect Node.js default metrics (GC, event loop, etc.)
    collectDefaultMetrics({ register: this.registry, prefix: "aof_" });

    this.tasksTotal = new Gauge({
      name: "aof_tasks_total",
      help: "Total tasks by agent and state",
      labelNames: ["agent", "state"] as const,
      registers: [this.registry],
    });

    this.delegationEventsTotal = new Counter({
      name: "aof_delegation_events_total",
      help: "Delegation events between agents",
      labelNames: ["from_agent", "to_agent"] as const,
      registers: [this.registry],
    });

    this.orgChartMutationsTotal = new Counter({
      name: "aof_org_chart_mutations_total",
      help: "Org chart configuration changes",
      labelNames: ["mutation_type"] as const,
      registers: [this.registry],
    });

    this.schedulerLoopDuration = new Histogram({
      name: "aof_scheduler_loop_duration_seconds",
      help: "Scheduler poll loop duration",
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
      registers: [this.registry],
    });

    this.taskStaleness = new Gauge({
      name: "aof_task_staleness_seconds",
      help: "Time since lease acquired for in-progress tasks",
      labelNames: ["agent", "task_id"] as const,
      registers: [this.registry],
    });

    this.lockAcquisitionFailures = new Counter({
      name: "aof_lock_acquisition_failures_total",
      help: "Failed lock acquisitions due to contention",
      registers: [this.registry],
    });

    this.schedulerUp = new Gauge({
      name: "aof_scheduler_up",
      help: "Scheduler process status (1=up, 0=down)",
      registers: [this.registry],
    });

    this.schedulerPollFailures = new Counter({
      name: "aof_scheduler_poll_failures_total",
      help: "Scheduler poll loop failures",
      registers: [this.registry],
    });

    this.contextBundleChars = new Gauge({
      name: "aof_context_bundle_chars",
      help: "Context bundle size in characters",
      labelNames: ["taskId", "agentId"] as const,
      registers: [this.registry],
    });

    this.contextBundleTokens = new Gauge({
      name: "aof_context_bundle_tokens",
      help: "Context bundle estimated token count",
      labelNames: ["taskId", "agentId"] as const,
      registers: [this.registry],
    });

    this.contextBudgetStatus = new Counter({
      name: "aof_context_budget_status",
      help: "Context budget status events",
      labelNames: ["taskId", "status"] as const,
      registers: [this.registry],
    });

    this.agentContextBytes = new Gauge({
      name: "aof_agent_context_bytes",
      help: "Per-agent context size in bytes (characters)",
      labelNames: ["agentId"] as const,
      registers: [this.registry],
    });

    this.agentContextTokens = new Gauge({
      name: "aof_agent_context_tokens",
      help: "Per-agent estimated token count",
      labelNames: ["agentId"] as const,
      registers: [this.registry],
    });

    // Gate telemetry metrics
    this.gateDuration = new Histogram({
      name: "aof_gate_duration_seconds",
      help: "Time spent in each gate",
      labelNames: ["project", "workflow", "gate", "outcome"] as const,
      buckets: [60, 300, 600, 1800, 3600, 7200, 14400, 28800, 86400], // 1m to 24h
      registers: [this.registry],
    });

    this.gateTransitionsTotal = new Counter({
      name: "aof_gate_transitions_total",
      help: "Total gate transitions",
      labelNames: ["project", "workflow", "from_gate", "to_gate", "outcome"] as const,
      registers: [this.registry],
    });

    this.gateRejectionsTotal = new Counter({
      name: "aof_gate_rejections_total",
      help: "Total gate rejections",
      labelNames: ["project", "workflow", "gate", "rejected_by_role"] as const,
      registers: [this.registry],
    });

    this.gateTimeoutsTotal = new Counter({
      name: "aof_gate_timeouts_total",
      help: "Total gate timeouts",
      labelNames: ["project", "workflow", "gate"] as const,
      registers: [this.registry],
    });

    this.gateEscalationsTotal = new Counter({
      name: "aof_gate_escalations_total",
      help: "Total gate escalations",
      labelNames: ["project", "workflow", "gate", "escalated_to_role"] as const,
      registers: [this.registry],
    });
  }

  /**
   * Update gauge metrics from current state.
   * Called before each /metrics scrape.
   */
  updateFromState(state: MetricsState): void {
    // Reset task gauges (they're point-in-time)
    this.tasksTotal.reset();
    this.taskStaleness.reset();

    // Task counts by status (aggregate with agent="all")
    for (const [status, count] of Object.entries(state.tasksByStatus)) {
      this.tasksTotal.labels({ agent: "all", state: status }).set(count);
    }

    // Task counts by agent + status
    for (const { agent, status, count } of state.tasksByAgentAndStatus) {
      this.tasksTotal.labels({ agent, state: status }).set(count);
    }

    // Stale tasks
    for (const { agent, taskId, stalenessSeconds } of state.staleTasks) {
      this.taskStaleness.labels({ agent, task_id: taskId }).set(stalenessSeconds);
    }

    // Scheduler status
    this.schedulerUp.set(state.schedulerUp ? 1 : 0);
  }

  /** Record a scheduler poll duration. */
  observePollDuration(durationSeconds: number): void {
    this.schedulerLoopDuration.observe(durationSeconds);
  }

  /** Record a delegation event. */
  recordDelegation(fromAgent: string, toAgent: string): void {
    this.delegationEventsTotal.labels({ from_agent: fromAgent, to_agent: toAgent }).inc();
  }

  /** Record an org chart mutation. */
  recordOrgMutation(mutationType: string): void {
    this.orgChartMutationsTotal.labels({ mutation_type: mutationType }).inc();
  }

  /** Record a lock acquisition failure. */
  recordLockFailure(): void {
    this.lockAcquisitionFailures.inc();
  }

  /** Record a poll failure. */
  recordPollFailure(): void {
    this.schedulerPollFailures.inc();
  }

  /** Record context bundle metrics. */
  recordContextBundle(
    taskId: string,
    agentId: string,
    totalChars: number,
    estimatedTokens: number,
    status: "ok" | "warn" | "critical" | "over"
  ): void {
    this.contextBundleChars.labels({ taskId, agentId }).set(totalChars);
    this.contextBundleTokens.labels({ taskId, agentId }).set(estimatedTokens);
    this.contextBudgetStatus.labels({ taskId, status }).inc();
  }

  /** Record agent footprint metrics. */
  recordAgentFootprint(agentId: string, totalChars: number, estimatedTokens: number): void {
    this.agentContextBytes.labels({ agentId }).set(totalChars);
    this.agentContextTokens.labels({ agentId }).set(estimatedTokens);
  }

  /** Record gate duration. */
  recordGateDuration(
    project: string,
    workflow: string,
    gate: string,
    outcome: string,
    seconds: number
  ): void {
    this.gateDuration.labels({ project, workflow, gate, outcome }).observe(seconds);
  }

  /** Record gate transition. */
  recordGateTransition(
    project: string,
    workflow: string,
    fromGate: string,
    toGate: string,
    outcome: string
  ): void {
    this.gateTransitionsTotal
      .labels({ project, workflow, from_gate: fromGate, to_gate: toGate, outcome })
      .inc();
  }

  /** Record gate rejection. */
  recordGateRejection(
    project: string,
    workflow: string,
    gate: string,
    rejectedByRole: string
  ): void {
    this.gateRejectionsTotal
      .labels({ project, workflow, gate, rejected_by_role: rejectedByRole })
      .inc();
  }

  /** Record gate timeout. */
  recordGateTimeout(project: string, workflow: string, gate: string): void {
    this.gateTimeoutsTotal.labels({ project, workflow, gate }).inc();
  }

  /** Record gate escalation. */
  recordGateEscalation(
    project: string,
    workflow: string,
    gate: string,
    escalatedToRole: string
  ): void {
    this.gateEscalationsTotal
      .labels({ project, workflow, gate, escalated_to_role: escalatedToRole })
      .inc();
  }

  /** Get metrics in Prometheus text format. */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}

/**
 * Start a Prometheus metrics HTTP server.
 */
export function startMetricsServer(
  port: number,
  metrics: AOFMetrics,
  getState: () => Promise<MetricsState>,
): Server {
  const server = createServer(async (req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      try {
        const state = await getState();
        metrics.updateFromState(state);
        const body = await metrics.getMetrics();
        res.writeHead(200, {
          "Content-Type": metrics.registry.contentType,
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500);
        res.end(`Error: ${(err as Error).message}\n`);
      }
    } else if (req.url === "/health") {
      res.writeHead(200);
      res.end("ok\n");
    } else {
      res.writeHead(404);
      res.end("Not Found\n");
    }
  });

  server.listen(port, () => {
    console.log(`📊 Metrics server listening on :${port}/metrics`);
  });

  return server;
}
