# Phase 1.5 Recovery Hardening — Kickoff Complete

**Date:** 2026-02-13  
**Architect:** swe-architect (subagent)  
**Status:** ✅ Kickoff tasks complete, backend can begin implementation

---

## Summary

Phase 1.5 Recovery Hardening is fully scoped and delegated. Backend has 4 ready tasks, QA and tech-writer have been notified of upcoming work.

---

## Tasks Created (8 total)

| Task ID | Title | Status | Owner | Estimate | Dependencies |
|---------|-------|--------|-------|----------|--------------|
| AOF-kux | Add daemon health monitoring (watchdog service) | open | Backend | 3d | None |
| AOF-l7y | Add CLI recovery hooks (--recover-on-failure) | open | Backend | 2d | None |
| AOF-p3k | Implement deadletter status + resurrection command | open | Backend | 2d | None |
| AOF-09x | Add SLA primitive to task schema | open | Backend | 1d | None |
| AOF-ae6 | Integrate SLA checks into scheduler | open | Backend | 2d | AOF-09x |
| AOF-1m9 | Add ops alerting for deadletter tasks | open | Backend | 2d | AOF-p3k |
| AOF-36q | Write integration tests for stall recovery | open | QA | 3d | AOF-kux, AOF-l7y, AOF-p3k, AOF-ae6 |
| AOF-amg | Update docs: recovery behavior + runbook | open | Tech Writer | 1d | All above |

**Total Effort:** ~16 person-days  
**Critical Path:** Backend → QA → Tech Writer

---

## Design Docs Written

1. **docs/design/DAEMON-WATCHDOG-DESIGN.md**
   - Health endpoint specification
   - Watchdog plugin architecture
   - Restart policy (3x in 1hr, then alert)
   - Deployment patterns (OpenClaw, systemd, Docker)

2. **docs/design/SLA-PRIMITIVE-DESIGN.md**
   - Task schema extension (per-task overrides)
   - org-chart.yaml defaults (1hr normal, 4hr research)
   - Scheduler integration (poll cycle checks)
   - Alert format and rate limiting

---

## Delegation Complete

### Backend (4 task briefs delivered)
**Mailbox:** `~/Projects/AOF/mailbox/swe-backend/inbox/`

1. `task-aof-kux-daemon-watchdog.md` — Daemon health monitoring
2. `task-aof-l7y-cli-recovery.md` — CLI recovery hooks
3. `task-aof-p3k-deadletter.md` — Deadletter status + resurrection
4. `task-aof-09x-sla-schema.md` — SLA primitive to task schema

**Ready to start:** All 4 tasks have no blockers.

**Backend action items:**
- Claim tasks: `bd update <task-id> --claim --json`
- Implement in order: AOF-kux, AOF-l7y, AOF-p3k, AOF-09x (then AOF-ae6, AOF-1m9)
- Close tasks: `bd close <task-id> --json`

---

### QA (heads-up notification sent)
**Mailbox:** `~/Projects/AOF/mailbox/swe-qa/inbox/`

- `phase-1.5-recovery-testing-heads-up.md`
- Task AOF-36q will become ready after backend completes 4 prerequisite tasks
- Estimate: 3 days of integration testing
- Covers: daemon restart, CLI recovery, deadletter, SLA violations, end-to-end stall recovery

---

### Tech Writer (heads-up notification sent)
**Mailbox:** `~/Projects/AOF/mailbox/tech-writer/inbox/`

- `phase-1.5-recovery-docs-heads-up.md`
- Task AOF-amg will become ready after QA pass
- Estimate: 1 day of documentation work
- Deliverables:
  - `docs/RECOVERY-RUNBOOK.md` (user guide)
  - `docs/DEPLOYMENT.md` (ops patterns)
  - `docs/SLA-GUIDE.md` (configuration guide)

---

## Ready Tasks (bd ready)

```bash
$ cd ~/Projects/AOF && bd ready --json
```

**4 tasks ready immediately:**
- AOF-kux (daemon watchdog)
- AOF-l7y (CLI recovery)
- AOF-p3k (deadletter)
- AOF-09x (SLA schema)

**After AOF-09x complete:**
- AOF-ae6 (SLA scheduler integration)

**After AOF-p3k complete:**
- AOF-1m9 (deadletter alerting)

**After backend complete:**
- AOF-36q (QA integration tests)

**After QA complete:**
- AOF-amg (tech writer docs)

---

## Next Steps (Backend)

1. **Claim first task:** `bd update AOF-kux --claim --json`
2. **Read design doc:** `docs/design/DAEMON-WATCHDOG-DESIGN.md`
3. **Implement health endpoint:** `src/daemon/health.ts`
4. **Write tests** (TDD: tests before implementation)
5. **Close task:** `bd close AOF-kux --json`
6. **Repeat for AOF-l7y, AOF-p3k, AOF-09x**

---

## Gate Structure

### Gate 1: Unit Tests
- Backend writes unit tests for all components
- Tests run locally: `cd ~/Projects/AOF && npx vitest run`
- All tests must pass before moving to Gate 2

### Gate 2: Integration Tests (Local)
- QA writes integration tests (AOF-36q)
- Tests run locally: `npx vitest run tests/integration/stall-recovery.test.ts`
- Validates: daemon restart, CLI recovery, deadletter, SLA
- All tests must pass before moving to Gate 3

### Gate 3: Integration Tests (Mule Sandbox)
- Deploy updated AOF to Mule (remote integration environment)
- Run integration tests on Mule
- Observe: Can the ant farm SWE team self-recover from stalls?
- PO validates recovery behavior matches requirements

---

## Requirements Reference

**Full context:** `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md`

**Key sections:**
- §1: Daemon auto-restart policy (3x in 1hr, then alert)
- §2: CLI recovery behavior (opt-in with `--recover-on-failure`)
- §3: Deadletter semantics (manual resurrection, no auto-unblock)
- §4: SLA defaults (1hr normal, 4hr research, advisory mode)
- §5: Task breakdown (AOF-sr1 through sr8)

---

## Open Questions (None)

All design decisions are documented in design docs. If backend has implementation questions, they can:
1. Check design doc first
2. Leave message in: `~/Projects/AOF/mailbox/swe-architect/inbox/`
3. Architect will respond within 4 hours during work hours

---

## Risk Mitigations

### Watchdog adds external dependency
- **Mitigation:** Watchdog is optional/pluggable (disabled by default)
- **Fallback:** Standalone AOF runs without watchdog (manual restart via systemd/Docker)

### SLA enforcement could be noisy
- **Mitigation:** Phase 1 is advisory only (alerts, no blocking)
- **Tuning:** Defaults are generous (1hr/4hr), projects can override

### CLI recovery could mask real errors
- **Mitigation:** Recovery actions logged to events.jsonl (observable)
- **Mitigation:** Recovery output shown to user (transparent)
- **Mitigation:** Recovery checks state once (no infinite retry)

### Deadletter could become dumping ground
- **Mitigation:** Deadletter alerts are mandatory (can't be disabled)
- **Mitigation:** Dashboard will show age of tasks (Phase 2)

---

## Success Metrics (Gate 3)

- [ ] Daemon can self-restart after crash (up to 3x)
- [ ] CLI recovery hooks reduce manual intervention by >50%
- [ ] Deadletter tasks are investigated within 24hr (ops SLA)
- [ ] SLA violation alerts are actionable (ops can triage without architect)
- [ ] Zero tasks stall indefinitely (all stalls detected within 1hr)

---

## Phase 2 Scope (Deferred)

After Phase 1.5 validation:
- CLI recovery as default (`--no-recovery` opt-out)
- Deadletter dashboard UI
- SLA blocking modes (`block`, `deadletter` on violation)
- Weekly digest emails (deadletter tasks >7 days old)
- Reduce poll interval to 10s (faster stall detection)

---

**Status:** ✅ All kickoff tasks complete. Backend can begin implementation immediately.

**Next milestone:** Backend completes AOF-kux, AOF-l7y, AOF-p3k, AOF-09x (Gate 1 pass).
