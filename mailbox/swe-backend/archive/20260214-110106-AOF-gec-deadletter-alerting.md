# Task Brief — AOF-gec (Backend)

**Beads Task ID**: AOF-gec (claim with `bd update AOF-gec --claim`)

## Objective
Add ops alerting for deadletter tasks so operational visibility is immediate and consistent. This is a P2 requirement before Mule integration testing.

## Context
Cleanup completed; remaining P2s are SLA checks, deadletter ops alerting, and stall-recovery integration tests. Keep scope limited to alerting for deadletters only.

## Scope
- Locate deadletter handling path and add ops alerting at the correct point (on enqueue/deadletter transition).
- Use existing alerting/ops notification mechanism if present; otherwise wire into the minimal sanctioned path.
- Ensure alert includes task identity and failure context.
- Update relevant config if needed for alert routing.

## Acceptance Criteria
- Deadletter events trigger a single ops alert with useful context.
- No duplicate alerts for the same deadletter event.
- Existing tests remain green; add/adjust minimal tests.

## Out of Scope
- SLA checks (AOF-efr) and stall-recovery tests (AOF-36q).
- New alerting infrastructure beyond existing mechanisms.

## Dependencies
- None stated; verify with `bd show AOF-gec --json`.

## Estimated Tests
- 1–2 unit or integration tests covering deadletter alert emission.
