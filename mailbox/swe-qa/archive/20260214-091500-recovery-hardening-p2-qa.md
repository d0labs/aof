# Phase 1.5 Recovery Hardening (P2) - QA Assignments

This supports: **AOF-r7b**, **AOF-8cq**, **AOF-br2**, **AOF-tzd**, **AOF-1m9**. P3 tasks deferred.

## Objective
Design and execute testing strategy for recovery hardening features: watchdog health monitoring, recovery hook flag, deadletter status/resurrection, SLA primitive, and deadletter alerting. Ensure opt-in behavior and no regressions when disabled.

## Scope
- Create a test matrix spanning: default behavior (features off), opt-in enabled behavior, failure/recovery scenarios, and data/schema compatibility.
- Focus on CLI flag tests, state machine transitions, alert emission, and SLA validation.

## Acceptance Criteria
- Tests confirm **no behavior change** when features are disabled.
- Watchdog behavior: enabled vs. disabled; does not crash or leak processes; clean shutdown.
- Recovery hook: flag triggers recovery path; absent flag does not trigger.
- Deadletter: transition to deadletter, resurrection command restores task, and guards prevent accidental resurrection.
- SLA primitive: schema validation, defaults, and serialization/backward compatibility.
- Deadletter alerting: emitted only when configured; validates payload and routing.

## Out of Scope
- P3 MCP integrations
- Performance benchmarking beyond basic sanity

## Dependencies
- Backend implementation for each task (order: r7b → 8cq → br2 → tzd → 1m9).

## Estimated Tests
- 10–15 tests (unit + integration). Include at least 2 negative cases per feature.

Please coordinate with backend on test seams and minimal fixture requirements.
