import { describe, it, expect, beforeEach } from "vitest";
import { AOFMetrics, type MetricsState } from "../exporter.js";

function emptyState(): MetricsState {
  return {
    tasksByStatus: {},
    tasksByAgentAndStatus: [],
    staleTasks: [],
    schedulerUp: true,
  };
}

describe("AOFMetrics", () => {
  let metrics: AOFMetrics;

  beforeEach(() => {
    metrics = new AOFMetrics();
  });

  it("renders empty state without errors", async () => {
    metrics.updateFromState(emptyState());
    const output = await metrics.getMetrics();
    expect(output).toContain("aof_scheduler_up 1");
  });

  it("renders task counts by status with agent=all", async () => {
    const state = emptyState();
    state.tasksByStatus = { backlog: 3, ready: 1, done: 5 };
    metrics.updateFromState(state);
    const output = await metrics.getMetrics();

    expect(output).toContain('aof_tasks_total{agent="all",state="backlog"} 3');
    expect(output).toContain('aof_tasks_total{agent="all",state="ready"} 1');
    expect(output).toContain('aof_tasks_total{agent="all",state="done"} 5');
  });

  it("renders per-agent task counts", async () => {
    const state = emptyState();
    state.tasksByAgentAndStatus = [
      { agent: "swe-backend", status: "in-progress", count: 2 },
    ];
    metrics.updateFromState(state);
    const output = await metrics.getMetrics();

    expect(output).toContain('aof_tasks_total{agent="swe-backend",state="in-progress"} 2');
  });

  it("renders stale task metrics", async () => {
    const state = emptyState();
    state.staleTasks = [
      { agent: "swe-backend", taskId: "task-001", stalenessSeconds: 1800 },
    ];
    metrics.updateFromState(state);
    const output = await metrics.getMetrics();

    expect(output).toContain('aof_task_staleness_seconds{agent="swe-backend",task_id="task-001"} 1800');
  });

  it("records scheduler poll duration histogram", async () => {
    metrics.observePollDuration(0.012);
    metrics.observePollDuration(0.08);
    metrics.observePollDuration(0.5);
    const output = await metrics.getMetrics();

    expect(output).toContain("aof_scheduler_loop_duration_seconds_count 3");
    expect(output).toContain("aof_scheduler_loop_duration_seconds_sum");
  });

  it("records delegation events", async () => {
    metrics.recordDelegation("swe-architect", "swe-backend");
    metrics.recordDelegation("swe-architect", "swe-backend");
    const output = await metrics.getMetrics();

    expect(output).toContain('aof_delegation_events_total{from_agent="swe-architect",to_agent="swe-backend"} 2');
  });

  it("renders scheduler down state", async () => {
    const state = emptyState();
    state.schedulerUp = false;
    metrics.updateFromState(state);
    const output = await metrics.getMetrics();

    expect(output).toContain("aof_scheduler_up 0");
  });

  it("records poll failures", async () => {
    metrics.recordPollFailure();
    metrics.recordPollFailure();
    const output = await metrics.getMetrics();

    expect(output).toContain("aof_scheduler_poll_failures_total 2");
  });

  it("records lock acquisition failures", async () => {
    metrics.recordLockFailure();
    const output = await metrics.getMetrics();

    expect(output).toContain("aof_lock_acquisition_failures_total 1");
  });

  it("includes Node.js default metrics", async () => {
    const output = await metrics.getMetrics();
    // prom-client collectDefaultMetrics adds process metrics
    expect(output).toContain("aof_nodejs");
  });

  it("records context bundle metrics", async () => {
    metrics.recordContextBundle("TEST-001", "agent-main", 5000, 1250, "ok");
    const output = await metrics.getMetrics();

    expect(output).toContain('aof_context_bundle_chars{taskId="TEST-001",agentId="agent-main"} 5000');
    expect(output).toContain('aof_context_bundle_tokens{taskId="TEST-001",agentId="agent-main"} 1250');
    expect(output).toContain('aof_context_budget_status{taskId="TEST-001",status="ok"} 1');
  });

  it("tracks multiple context budget statuses", async () => {
    metrics.recordContextBundle("TEST-001", "agent-main", 5000, 1250, "ok");
    metrics.recordContextBundle("TEST-002", "agent-main", 15000, 3750, "warn");
    metrics.recordContextBundle("TEST-003", "agent-main", 25000, 6250, "critical");
    const output = await metrics.getMetrics();

    expect(output).toContain('aof_context_budget_status{taskId="TEST-001",status="ok"} 1');
    expect(output).toContain('aof_context_budget_status{taskId="TEST-002",status="warn"} 1');
    expect(output).toContain('aof_context_budget_status{taskId="TEST-003",status="critical"} 1');
  });

  it("increments context budget status counter on repeated events", async () => {
    metrics.recordContextBundle("TEST-001", "agent-main", 5000, 1250, "ok");
    metrics.recordContextBundle("TEST-001", "agent-main", 5100, 1275, "ok");
    const output = await metrics.getMetrics();

    expect(output).toContain('aof_context_budget_status{taskId="TEST-001",status="ok"} 2');
  });

  describe("Gate Telemetry", () => {
    it("records gate duration histogram", async () => {
      metrics.recordGateDuration("my-project", "standard", "implement", "complete", 3600);
      metrics.recordGateDuration("my-project", "standard", "review", "complete", 1800);
      const output = await metrics.getMetrics();

      expect(output).toContain('aof_gate_duration_seconds_count{project="my-project",workflow="standard",gate="implement",outcome="complete"} 1');
      expect(output).toContain('aof_gate_duration_seconds_count{project="my-project",workflow="standard",gate="review",outcome="complete"} 1');
      expect(output).toContain('aof_gate_duration_seconds_sum{project="my-project",workflow="standard",gate="implement",outcome="complete"} 3600');
      expect(output).toContain('aof_gate_duration_seconds_sum{project="my-project",workflow="standard",gate="review",outcome="complete"} 1800');
    });

    it("records gate transitions", async () => {
      metrics.recordGateTransition("my-project", "standard", "implement", "review", "complete");
      metrics.recordGateTransition("my-project", "standard", "review", "verify", "complete");
      const output = await metrics.getMetrics();

      expect(output).toContain('aof_gate_transitions_total{project="my-project",workflow="standard",from_gate="implement",to_gate="review"');
      expect(output).toContain('aof_gate_transitions_total{project="my-project",workflow="standard",from_gate="review",to_gate="verify"');
    });

    it("records gate rejections", async () => {
      metrics.recordGateRejection("my-project", "standard", "review", "swe-qa");
      metrics.recordGateRejection("my-project", "standard", "review", "swe-qa");
      const output = await metrics.getMetrics();

      expect(output).toContain('aof_gate_rejections_total{project="my-project",workflow="standard",gate="review",rejected_by_role="swe-qa"} 2');
    });

    it("records gate timeouts", async () => {
      metrics.recordGateTimeout("my-project", "standard", "implement");
      const output = await metrics.getMetrics();

      expect(output).toContain('aof_gate_timeouts_total{project="my-project",workflow="standard",gate="implement"} 1');
    });

    it("records gate escalations", async () => {
      metrics.recordGateEscalation("my-project", "standard", "implement", "swe-architect");
      const output = await metrics.getMetrics();

      expect(output).toContain('aof_gate_escalations_total{project="my-project",workflow="standard",gate="implement",escalated_to_role="swe-architect"} 1');
    });

    it("tracks multiple gates and workflows", async () => {
      metrics.recordGateDuration("proj-a", "standard", "implement", "complete", 1000);
      metrics.recordGateDuration("proj-b", "fast-track", "review", "complete", 500);
      const output = await metrics.getMetrics();

      expect(output).toContain('project="proj-a",workflow="standard",gate="implement"');
      expect(output).toContain('project="proj-b",workflow="fast-track",gate="review"');
    });
  });
});
