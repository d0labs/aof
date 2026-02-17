# Phase 1.5 Recovery Hardening (P2) - Backend Assignments

This implements: **AOF-r7b**, **AOF-8cq**, **AOF-br2**, **AOF-tzd**, **AOF-1m9** (claim in order). P3 tasks (AOF-zn7, AOF-e6x) are deferred.

## Objective
Implement sequential recovery hardening features for the daemon: watchdog health monitoring, CLI recovery hooks, deadletter state/resurrection, SLA primitive on tasks, and ops alerting for deadletters. All features must be opt-in and preserve AOF’s ejectable design philosophy.

## Dependency/Order Guidance
1. **AOF-r7b** (watchdog) → 2. **AOF-8cq** (recover-on-failure hooks) → 3. **AOF-br2** (deadletter status + resurrection) → 4. **AOF-tzd** (SLA primitive) → 5. **AOF-1m9** (ops alerting for deadletter)

## Scope (high-level)
- Daemon internals: health monitoring/watchdog service (likely separate module/service with minimal coupling).
- CLI: recovery hook flag(s) such as `--recover-on-failure`, ensure opt-in default.
- State machine: add deadletter status, transitions, and resurrection command path.
- Schema: add SLA primitive to task model (minimal changes, backwards compatible).
- Alerting: emit ops alert for deadletter tasks (event/notification layer). Prefer table-driven logic.

## Acceptance Criteria (each task)
- **AOF-r7b**: Watchdog monitors daemon health; doesn’t change default runtime unless enabled. Clean start/stop; no global side effects.
- **AOF-8cq**: `--recover-on-failure` hook exists; recover path is isolated, opt-in, and does not run by default.
- **AOF-br2**: Deadletter status exists; resurrection command restores tasks safely; no silent implicit resurrection.
- **AOF-tzd**: SLA primitive added to task schema with clear validation; default behavior unchanged when absent.
- **AOF-1m9**: Deadletter alerting is opt-in and tied to deadletter events; configurable and ejectable.

## Out of Scope
- P3 MCP integrations (AOF-zn7, AOF-e6x)
- Mandatory recovery behavior or always-on monitoring
- Broad refactors unrelated to recovery

## Dependencies
- Each task depends on the prior task in order above. Keep interfaces minimal; avoid large shared abstractions.

## Estimated Tests
- 8–12 total unit/integration tests across tasks. Focus on opt-in behavior, state transitions, CLI flag behavior, alert emission.

## Notes
- Maintain small modules (<300 LOC) and functions (<60 LOC). Avoid duplicate implementations; remove obsolete paths when replacing.
- Use table-driven logic for state transitions or alert routing if >3 branches.

Claim tasks as you start each: `bd update AOF-r7b --claim --json` (then sequentially). Close when done.
