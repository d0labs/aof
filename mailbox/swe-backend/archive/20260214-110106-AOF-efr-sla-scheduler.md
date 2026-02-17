# Task Brief — AOF-efr (Backend)

**Beads Task ID**: AOF-efr (claim with `bd update AOF-efr --claim`)

## Objective
Integrate SLA checks into the scheduler so tasks exceeding SLA are detected and handled consistently. This keeps runtime health aligned with P2 readiness toward Mule integration testing.

## Context
Recent cleanup completed; remaining P2s are scheduler SLA checks, ops alerting for deadletters, and stall-recovery integration tests. No further scope requested beyond SLA checks.

## Scope
- Identify scheduler entry points where task timing is evaluated.
- Add SLA evaluation logic and ensure it triggers the existing/appropriate handling path (e.g., marking, escalation hooks, or state updates).
- Update or create any minimal config/hooks required for SLA thresholds.
- Files likely under scheduler/task orchestration modules; use `bd show AOF-efr --json` for exact context.

## Acceptance Criteria
- Scheduler evaluates SLA for tasks on the expected cadence.
- SLA violations are deterministically detected and routed to the intended handling path.
- No new branching complexity; prefer table-driven/param-based logic if multiple SLA types.
- Existing scheduler tests remain green; add/adjust unit tests if needed.

## Out of Scope
- New alerting channels or ops integrations (handled in AOF-gec).
- Broad refactors unrelated to SLA checks.

## Dependencies
- None stated; verify with `bd show AOF-efr --json`.

## Estimated Tests
- 1–3 unit tests (scheduler behavior). If a light integration test exists, update as needed.
