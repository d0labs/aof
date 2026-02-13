# Phase 1.5 Recovery Hardening - Kickoff Complete
**Date:** 2026-02-13  
**Architect:** swe-architect  
**Status:** ✅ Ready for Backend Implementation

---

## Summary

Successfully processed PO's recovery requirements and prepared Phase 1.5 for implementation. All tasks created, dependencies mapped, and design docs written. Backend specialists can now claim ready tasks.

---

## What Was Done

### 1. ✅ Task Creation (8 tasks)

Created beads tasks with proper dependencies:

| Task ID | Title | Status | Owner | Estimate | Blocks |
|---------|-------|--------|-------|----------|--------|
| AOF-r7b | Daemon health monitoring | **ready** | Backend | 3d | AOF-6lw, AOF-ws1 |
| AOF-8cq | CLI recovery hooks | **ready** | Backend | 2d | AOF-6lw, AOF-ws1 |
| AOF-br2 | Deadletter status | **ready** | Backend | 2d | AOF-gec, AOF-6lw, AOF-ws1 |
| AOF-tzd | SLA primitive schema | **ready** | Backend | 1d | AOF-efr, AOF-ws1 |
| AOF-efr | SLA scheduler integration | blocked | Backend | 2d | AOF-6lw, AOF-ws1 |
| AOF-gec | Deadletter alerting | blocked | Backend | 2d | AOF-ws1 |
| AOF-6lw | Integration tests | blocked | QA | 3d | AOF-ws1 |
| AOF-ws1 | Documentation | blocked | Tech Writer | 1d | — |

**Total effort:** ~16 person-days (as estimated by PO)

### 2. ✅ Design Documents Written

**`docs/DAEMON-WATCHDOG-DESIGN.md`** (6.7 KB)
- Health check endpoint design (`GET /health`)
- Watchdog service architecture (auto-restart up to 3x)
- Integration patterns (OpenClaw, systemd, Docker)
- Event logging schema
- CLI commands
- Testing strategy

**`docs/SLA-PRIMITIVE-DESIGN.md`** (9.8 KB)
- Task schema extensions (per-task SLA overrides)
- Project config extensions (default SLA limits)
- SLA resolution algorithm (task > project > global)
- Scheduler integration (check violations every poll)
- Violation handling (alert-only in Phase 1)
- Rate limiting (max 1 alert per task per 15min)
- CLI commands and testing strategy

### 3. ✅ Mailbox System Initialized

Created coordination infrastructure:
- `mailbox/swe-architect/inbox/` — for incoming messages
- `mailbox/swe-architect/archive/` — for processed messages
- Archived PO's recovery requirements message

### 4. ✅ Git Commit

Committed all changes to local repository:
```
commit 6f8ba62
Phase 1.5 Recovery Hardening: tasks and design docs
```

---

## Next Steps (For Backend Specialists)

### Immediate Work (4 tasks ready)

These tasks can be worked on **in parallel** (no dependencies):

1. **AOF-r7b: Daemon health monitoring** (3d)
   - See design doc: `docs/DAEMON-WATCHDOG-DESIGN.md`
   - Files to create: `src/daemon/health.ts`, `src/daemon/watchdog.ts`
   - Deliverable: Health endpoint + watchdog service (opt-in)

2. **AOF-8cq: CLI recovery hooks** (2d)
   - Add `--recover-on-failure` flag to CLI commands
   - Files to modify: `src/cli/*.ts`, `src/recovery/*.ts`
   - Deliverable: CLI commands can check lease/heartbeat on failure

3. **AOF-br2: Deadletter status** (2d)
   - Add deadletter to task state machine
   - Implement `aof task resurrect <id>` command
   - Files to modify: `src/schemas/task-schema.ts`, `src/cli/*.ts`
   - Deliverable: Tasks can transition to/from deadletter

4. **AOF-tzd: SLA primitive schema** (1d)
   - See design doc: `docs/SLA-PRIMITIVE-DESIGN.md`
   - Files to modify: `src/schemas/task-schema.ts`, `src/config/org-chart-schema.ts`
   - Deliverable: Task schema supports SLA fields

### Subsequent Work (after blockers complete)

5. **AOF-efr: SLA scheduler integration** (2d)
   - **Blocked by:** AOF-tzd
   - Integrate SLA checks into scheduler poll loop
   - Files to modify: `src/dispatch/scheduler.ts`

6. **AOF-gec: Deadletter alerting** (2d)
   - **Blocked by:** AOF-br2
   - Send ops alerts when task transitions to deadletter
   - Files to create: `src/events/alerting.ts` (or similar)

7. **AOF-6lw: Integration tests** (3d)
   - **Blocked by:** AOF-r7b, AOF-8cq, AOF-br2, AOF-efr
   - Write e2e tests for all recovery scenarios
   - Files to create: `tests/e2e/recovery/*.test.ts`

8. **AOF-ws1: Documentation** (1d)
   - **Blocked by:** All above
   - Write `docs/RECOVERY-RUNBOOK.md`, `docs/DEPLOYMENT.md`, `docs/SLA-GUIDE.md`

---

## Delegation Instructions (For Architect)

When ready to delegate, use the spawn-agent.sh script:

```bash
# For each ready task, create a brief and spawn specialist
bash ~/.openclaw/scripts/spawn-agent.sh swe-backend /tmp/task-brief-AOF-r7b.md medium
bash ~/.openclaw/scripts/spawn-agent.sh swe-backend /tmp/task-brief-AOF-8cq.md medium
bash ~/.openclaw/scripts/spawn-agent.sh swe-backend /tmp/task-brief-AOF-br2.md medium
bash ~/.openclaw/scripts/spawn-agent.sh swe-backend /tmp/task-brief-AOF-tzd.md low
```

**Task brief format** (see AGENTS.md):
- Beads Task ID (e.g., "This implements AOF-r7b")
- Objective (what and why)
- Scope (files to create/modify)
- Acceptance Criteria (testable conditions)
- Out of Scope (explicit boundaries)
- Dependencies (what must exist first)
- Estimated Tests (number and type)

---

## PO Acceptance Criteria (Phase 1.5 Complete)

Before declaring Phase 1.5 complete, validate:

### Functional Requirements
- ✅ Daemon health check endpoint returns 200 when healthy
- ✅ Watchdog restarts daemon on failure (up to 3x in 1hr)
- ✅ After 3 restarts, watchdog alerts ops and stops
- ✅ CLI commands accept `--recover-on-failure` flag
- ✅ CLI recovery checks lease expiry and heartbeat staleness
- ✅ Recovery actions logged to events.jsonl
- ✅ Deadletter status added to task state machine
- ✅ After 3 dispatch failures, task → deadletter
- ✅ Deadletter tasks trigger ops alerts
- ✅ `aof task resurrect <id>` command exists
- ✅ SLA primitive added to task schema
- ✅ Scheduler checks SLA violations every poll cycle
- ✅ SLA violations emit alerts to ops channel

### Non-Functional Requirements
- ✅ Integration tests cover all recovery scenarios
- ✅ Recovery behavior documented
- ✅ Watchdog deployment patterns documented
- ✅ SLA configuration examples documented

### Gate 3 Validation
- ✅ QA runs integration tests on Mule sandbox
- ✅ PO validates recovery behavior
- ✅ PO validates alert messages are actionable
- ✅ PO validates CLI output is user-friendly

---

## References

- **PO Requirements:** `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md`
- **Design Docs:** `docs/DAEMON-WATCHDOG-DESIGN.md`, `docs/SLA-PRIMITIVE-DESIGN.md`
- **Beads Commands:**
  - View ready work: `bd ready --json`
  - View task details: `bd show AOF-r7b --json`
  - Claim task: `bd update AOF-r7b --claim --json`
  - Close task: `bd close AOF-r7b --json`

---

**Status:** Ready for backend implementation. All preparatory work complete. 🚀
