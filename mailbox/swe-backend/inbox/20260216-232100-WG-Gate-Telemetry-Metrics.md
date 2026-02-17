# Task Brief: WG Gate Telemetry (Prometheus Metrics)

**Beads Task:** AOF-mmd  
**Status:** Blocked by AOF-9eq (scheduler gate transition handler)  
**Estimated Effort:** Medium (M) — 3 hours max  
**Assigned To:** swe-backend

---

## Objective

Add core gate telemetry to Prometheus metrics: gate duration, transitions, and rejections. Emit metrics on every gate transition so PM/PO dashboards can track bottlenecks and rejection rates.

## What to Build

### 1. Extend Metrics exporter

Modify `src/metrics/exporter.ts` to add new metrics to `AOFMetrics`:

```typescript
readonly gateDuration: Histogram;          // aof_gate_duration_seconds
readonly gateTransitionsTotal: Counter;    // aof_gate_transitions_total
readonly gateRejectionsTotal: Counter;     // aof_gate_rejections_total
```

Labels (use consistent names):
- `project`, `workflow`, `gate`, `outcome`
- `from_gate`, `to_gate` for transitions

Add helper methods:

```typescript
recordGateDuration(project: string, workflow: string, gate: string, outcome: string, seconds: number): void
recordGateTransition(project: string, workflow: string, fromGate: string, toGate: string, outcome: string): void
recordGateRejection(project: string, workflow: string, gate: string): void
```

### 2. Emit metrics from scheduler

Modify `src/dispatch/scheduler.ts` (or the gate transition handler) to call the new metric helpers **when a gate transition occurs**:
- On **complete**: record duration + transition to next gate
- On **needs_review**: record duration + transition to implement + rejection counter
- On **blocked**: record duration if exiting gate (or skip; keep consistent)

Use `task.frontmatter.project` and `workflow.name` for labels.

### 3. Optional: active tasks per gate (if trivial)

If available with low effort, add a **gauge** in `collectMetrics()` to report `aof_gate_active_tasks{project,workflow,gate}` by scanning task frontmatter.gate.current. Otherwise, defer (note in brief).

## File Structure

```
src/metrics/exporter.ts (modify)
  - Add new Histogram/Counter metrics
  - Add recordGateDuration/recordGateTransition/recordGateRejection

src/dispatch/scheduler.ts (modify)
  - Emit gate metrics during handleGateTransition

src/metrics/collector.ts (optional)
  - Add gate active tasks gauge if trivial
```

## Acceptance Criteria

1. ✅ Prometheus exposes `aof_gate_duration_seconds`, `aof_gate_transitions_total`, `aof_gate_rejections_total`
2. ✅ Metrics emitted on every gate transition
3. ✅ Labels include `project`, `workflow`, `gate`, `outcome` (and from/to for transitions)
4. ✅ No impact to existing metrics tests
5. ✅ `npx vitest run src/metrics/__tests__/exporter.test.ts` passes

## Dependencies

**Blocked by:**
- AOF-9eq (Scheduler gate transition handler)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 6.4)
- Metrics exporter: `src/metrics/exporter.ts`

## Testing

Add or update unit tests in `src/metrics/__tests__/exporter.test.ts` to verify new metric names and labels.

## Out of Scope

- Grafana dashboards
- Event stream logging (handled elsewhere)
- Advanced analytics (DORA metrics)

## Estimated Tests

2–3 unit tests (metric presence + label formatting)

---

**To claim this task:** `bd update AOF-mmd --claim --json`  
**To complete:** `bd close AOF-mmd --json`
