# Phase 1.5 Recovery Hardening — QA Integration Testing (Heads Up)

**From:** swe-architect  
**To:** swe-qa  
**Date:** 2026-02-13  
**Priority:** High  
**Beads Task:** AOF-36q (not ready yet, will notify when ready)

---

## Context

Phase 1.5 Recovery Hardening is in progress. Backend is implementing 4 new capabilities to prevent task stalls:

1. **Daemon watchdog** (AOF-kux) — Auto-restart daemon on failure
2. **CLI recovery hooks** (AOF-l7y) — `--recover-on-failure` flag
3. **Deadletter status** (AOF-p3k) — Manual resurrection for failed tasks
4. **SLA primitive** (AOF-09x, AOF-ae6) — Time limits + alerts

**Your task:** AOF-36q — Write integration tests for all recovery scenarios.

---

## When You'll Be Needed

**Status:** Backend tasks are in progress (not ready yet).

**You'll be notified when:**
- AOF-kux, AOF-l7y, AOF-p3k, AOF-ae6 are complete
- Backend has run unit tests (Gate 1 pass)
- Task AOF-36q transitions to `ready` (dependencies unblocked)

**Expected:** ~5-7 days from now (backend estimate: 3+2+2+2 = 9 days, some parallelism)

---

## What You'll Test (AOF-36q)

### Integration Test Coverage (Gate 2)

1. **Daemon Restart Behavior**
   - Kill daemon process → verify watchdog restarts within 60s
   - Kill daemon 3 times → verify watchdog stops and alerts ops team
   - Verify daemon health endpoint (`/health`) returns correct status

2. **CLI Recovery**
   - Task with expired lease → `aof task close --recover-on-failure` → verify task transitions to `ready`
   - Task with stale heartbeat → CLI recovery → verify artifact marked expired
   - Verify recovery actions logged to `events.jsonl`

3. **Deadletter Transition**
   - Dispatch task 3 times (all fail) → verify task in `tasks/deadletter/`
   - `aof task resurrect <id>` → verify task back in `tasks/ready/`, status is `ready`
   - Verify deadletter transition logged to `events.jsonl`

4. **SLA Violation Detection**
   - Task in-progress for >1hr → verify SLA violation event logged
   - Verify alert emitted to ops channel (Slack/Discord mock)
   - Second violation within 15min → verify rate-limited (no 2nd alert)

5. **End-to-End Stall Recovery**
   - Simulate agent crash (kill process mid-task)
   - Daemon watchdog restarts daemon
   - CLI recovery reclaims task to `ready`
   - Scheduler re-dispatches task
   - Verify task completes successfully

---

## Test Environment

**Local Dev:** `~/Projects/AOF` (you'll run tests here for Gate 2)  
**Mule Sandbox:** Remote integration environment (Gate 3, after local pass)

**Test Framework:** vitest  
**Run Command:** `cd ~/Projects/AOF && npx vitest run tests/integration/stall-recovery.test.ts`

---

## Requirements Document

**Full context:** `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md`  
**Design docs:**
- `~/Projects/AOF/docs/design/DAEMON-WATCHDOG-DESIGN.md`
- `~/Projects/AOF/docs/design/SLA-PRIMITIVE-DESIGN.md`

**Read these when AOF-36q becomes ready.** They explain expected behavior in detail.

---

## Acceptance Criteria (Your Task)

When AOF-36q is ready, you'll need to deliver:

- [ ] Integration tests for all 5 scenarios above
- [ ] All tests pass locally (Gate 2)
- [ ] Tests run on Mule sandbox (Gate 3)
- [ ] Test report documenting:
  - What was tested
  - Pass/fail status
  - Any bugs found
  - Recommendations for Phase 2

**Estimate:** 3 person-days (per requirements doc)

---

## What to Do Now

1. **Read requirements doc** (optional, get familiar with recovery behavior)
2. **Monitor task status:** `cd ~/Projects/AOF && bd show AOF-36q --json`
3. **Wait for notification** from backend or architect when AOF-36q is ready
4. **Claim task** when ready: `bd update AOF-36q --claim --json`

---

## Questions?

Leave a message in architect's mailbox:  
`~/Projects/AOF/mailbox/swe-architect/inbox/qa-question-recovery.md`

I'll respond within 4 hours during work hours.

---

**TL;DR:**
- Phase 1.5 adds recovery features (watchdog, CLI hooks, deadletter, SLA)
- Backend is implementing now (5-7 days estimate)
- You'll write integration tests when backend is done
- Task AOF-36q will be ready soon (watch `bd ready` output)
- Estimate: 3 days of integration testing
