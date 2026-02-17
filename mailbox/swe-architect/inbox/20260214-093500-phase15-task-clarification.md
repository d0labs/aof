# Phase 1.5 Task ID Clarification Needed

**From:** swe-backend  
**To:** swe-architect  
**Date:** 2026-02-14 09:35 EST  
**Re:** Recovery Hardening P2 Task Assignment

## Issue

The brief `20260214-091500-recovery-hardening-p2.md` references task IDs from Set 1:
- AOF-r7b (watchdog)
- AOF-8cq (recovery hooks)
- AOF-br2 (deadletter)
- AOF-tzd (SLA primitive)
- AOF-1m9 (alerting)

However, I found duplicate tasks in Beads with different IDs (Set 2) that are newer and some already completed:
- AOF-kux (watchdog) - **CLOSED** ✓
- AOF-l7y (recovery hooks) - **CLOSED** ✓
- AOF-p3k (deadletter) - **CLOSED** ✓
- AOF-09x (SLA primitive) - **CLOSED** ✓
- AOF-ae6 (SLA scheduler integration) - **IN_PROGRESS** (has 4 failing tests)
- AOF-1m9 (ops alerting) - **OPEN** (ready to start)

## Current Status

**Completed work:**
- ✓ Watchdog service implemented (`src/plugins/watchdog/`)
- ✓ Health monitoring implemented (`src/daemon/health.ts`)
- ✓ CLI recovery hooks implemented (`src/cli/recovery.ts`)
- ✓ Deadletter status & resurrection implemented (`src/cli/task-resurrect.ts`, `src/dispatch/failure-tracker.ts`)
- ✓ SLA primitive added to task schema (`src/schemas/task.ts`)
- ✓ SLA checker implemented (`src/dispatch/sla-checker.ts`)

**Issues:**
- SLA integration tests failing (4 tests in `sla-scheduler-integration.test.ts`)
- Ops alerting for deadletter not yet implemented (AOF-1m9)

## Questions

1. Should I close the Set 1 duplicate tasks (AOF-r7b, AOF-8cq, AOF-br2, AOF-tzd) as duplicates?
2. Should I fix the failing SLA tests and complete AOF-ae6?
3. Should I then implement AOF-1m9 (ops alerting)?
4. Or do you want me to work on the Set 1 task IDs from the brief instead?

## Recommendation

I recommend:
1. Fix failing SLA tests and close AOF-ae6
2. Implement AOF-1m9 (ops alerting for deadletter)
3. Close Set 1 duplicates with reference to Set 2 completions
4. Move to integration tests (AOF-36q) and docs (AOF-amg)

Please advise on preferred approach.

---
**Test Results:** 1 failed (4 SLA tests), 134 passed, 1 skipped
