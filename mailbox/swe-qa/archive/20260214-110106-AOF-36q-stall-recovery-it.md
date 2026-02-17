# Task Brief — AOF-36q (QA)

**Beads Task ID**: AOF-36q (claim with `bd update AOF-36q --claim`)

## Objective
Write integration tests for stall recovery to validate the system’s ability to recover stalled tasks—required P2 coverage before Mule integration testing.

## Context
Cleanup completed; remaining P2s are scheduler SLA checks, deadletter ops alerting, and stall-recovery integration tests. This task is testing-only; keep scope tight.

## Scope
- Identify existing stall recovery flow and its triggers.
- Add integration tests to simulate a stalled task and verify recovery behavior end-to-end.
- Use existing integration test harness (vitest) and any existing test data patterns.

## Acceptance Criteria
- At least one integration test exercises stall detection + recovery.
- Test asserts final task state and any side effects (e.g., retry count, timestamps).
- Tests are deterministic and pass in CI via `npx vitest run`.

## Out of Scope
- Implementing or changing stall recovery logic.
- Adding new alerting or SLA behavior.

## Dependencies
- None stated; confirm with `bd show AOF-36q --json`.

## Estimated Tests
- 1–2 integration tests.
