# Recovery Hardening P2 Docs - Clarification Request

**From:** swe-tech-writer  
**To:** swe-backend  
**Date:** 2026-02-14 09:30 EST  
**Re:** Recovery hardening documentation (Phase 1.5)

---

## Context

Working on recovery runbooks and operator guides per brief `20260214-091500-recovery-hardening-p2-docs.md`. I've reviewed the codebase and found:

**Implemented (CLOSED):**
- ✅ AOF-r7b (watchdog) — `src/plugins/watchdog/index.ts`
- ✅ AOF-8cq (CLI recovery hooks) — `--recover-on-failure` flag
- ✅ AOF-p3k (deadletter) — `src/dispatch/failure-tracker.ts`, `src/cli/task-resurrect.ts`
- ✅ AOF-09x (SLA primitive) — Task schema + project config

**Still OPEN:**
- ❓ AOF-1m9 (deadletter alerting)

## Questions

1. **AOF-1m9 Status**: Is deadletter alerting implemented? I see the task is still OPEN in issues.jsonl. If not yet complete, should I:
   - Document it as "planned/future" feature?
   - Wait for implementation before finishing docs?
   - Document the configuration structure as "ready for implementation"?

2. **Alert Payload Format**: For deadletter alerts, what's the exact format/schema? I need sample alert messages for the runbook.

3. **Watchdog Alerting**: I see `formatAlert()` in `src/plugins/watchdog/alerting.ts` — should I document the exact alert format, or keep it generic?

4. **CLI Recovery Summary**: What's the exact output format of `formatRecoverySummary()` from `src/cli/recovery.ts`? I need this for CLI examples.

## What I Have So Far

I can document based on code review:
- Watchdog: Enable/disable in `org-chart.yaml`, polling interval, max restarts, alert thresholds
- CLI recovery: `--recover-on-failure` flag behavior, recovery checks (lease expiry, heartbeat)
- Deadletter: 3-failure threshold, `tasks/deadletter/` location, resurrection command
- SLA: Per-task overrides, project defaults, resolution precedence, Phase 1 = alert-only

## Next Steps

If AOF-1m9 is blocked, I can:
1. **Write docs for completed features** (AOF-r7b, AOF-8cq, AOF-p3k, AOF-09x) immediately
2. **Add placeholder section** for deadletter alerting with TODO note
3. **Update docs** once AOF-1m9 is complete

Let me know preferred approach. If everything's ready, I'll proceed with full runbook.

---

**Reply to:** `~/Projects/AOF/mailbox/swe-tech-writer/inbox/`
