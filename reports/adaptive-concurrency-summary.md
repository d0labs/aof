# Adaptive Concurrency — Design Summary

**Date**: 2026-02-16  
**Architect**: swe-architect  
**Status**: Ready for Implementation

---

## Problem Statement

AOF's scheduler has a static `maxConcurrentDispatches` (default 3), but OpenClaw enforces a runtime `maxChildrenPerAgent` limit. When AOF exceeds OpenClaw's limit, dispatches fail with:
```
sessions_spawn has reached max active children for this session (X/Y)
```

**Impact**:
- Tasks moved to `blocked` state incorrectly
- Retry counters incremented for capacity exhaustion (not real failures)
- No feedback loop to auto-adjust scheduler's effective cap

---

## Solution

Implement adaptive concurrency detection and auto-adjustment:

1. **Executor**: Parse platform limit from error messages, return `platformLimit` in `ExecutorResult`
2. **Scheduler**: Track `effectiveConcurrencyLimit` (min of platform limit and config)
3. **Action Planning**: Use effective cap instead of static config cap
4. **Error Handling**: Requeue tasks to `ready` (not `blocked`) when hitting platform limits
5. **Telemetry**: Emit `concurrency.platformLimit` events

---

## Architecture

```
Scheduler                                 Executor
┌────────────────────────┐               ┌─────────────────────────┐
│ effectiveConcurrency   │  spawn()      │ Parse platform limit    │
│ Limit: null | number   │ ────────────> │ from error message      │
│                        │               │                         │
│ Use min(platform,      │ <──────────── │ Return:                 │
│ config) for action     │  ExecutorResult│  { success, error,     │
│ planning               │               │    platformLimit? }     │
└────────────────────────┘               └─────────────────────────┘
```

---

## Files Modified

1. **`src/dispatch/executor.ts`** — Add `platformLimit?` to `ExecutorResult`
2. **`src/openclaw/openclaw-executor.ts`** — Parse platform limit, propagate in result
3. **`src/schemas/event.ts`** — Add `concurrency.platformLimit` event type
4. **`src/dispatch/scheduler.ts`** — Track effective cap, adjust on detection, use for planning

---

## Files Created (Tests)

5. **`src/openclaw/__tests__/openclaw-executor-platform-limit.test.ts`** — Executor parsing tests (3 tests)
6. **`src/dispatch/__tests__/scheduler-adaptive-concurrency.test.ts`** — Scheduler adaptive logic tests (5 tests)
7. **`src/dispatch/__tests__/e2e-platform-limit.test.ts`** — End-to-end integration tests (2 tests)

**Total**: 10 new tests

---

## Key Behaviors

### Before (Current)
- Scheduler tries to dispatch 3 concurrent tasks (default)
- OpenClaw platform limit is 2 → 3rd spawn fails
- Task moved to `blocked`, retry count incremented
- Next poll: tries to dispatch 3 again → same failure

### After (Adaptive)
- Scheduler tries to dispatch 3 concurrent tasks
- OpenClaw platform limit is 2 → 3rd spawn fails
- Scheduler detects platform limit: sets `effectiveConcurrencyLimit = 2`
- Task requeued to `ready` (not blocked), retry count NOT incremented
- Event emitted: `concurrency.platformLimit`
- Next poll: respects cap of 2, doesn't over-dispatch

---

## Testing Strategy

### Unit Tests (Executor)
- Parse "max active children for this session (X/Y)" → extract Y
- Non-platform-limit errors return undefined
- Handle various number formats

### Unit Tests (Scheduler)
- Auto-adjust effective cap when platform limit detected
- Use effective cap for action planning (concurrency gating)
- Requeue to ready (not blocked) on platform limit
- No retry count increment for platform limit errors
- Test min(platform, config) logic

### Integration Tests (E2E)
- Detect platform limit, requeue tasks, respect cap on next poll
- Tasks eventually dispatch as slots open

---

## Acceptance Criteria

- [x] Design complete
- [ ] Executor parses platform limit correctly
- [ ] Scheduler tracks effective cap and adjusts on detection
- [ ] Action planning uses effective cap
- [ ] Tasks requeued to ready (not blocked) on platform limit
- [ ] No retry count increment for platform limit errors
- [ ] Event `concurrency.platformLimit` emitted
- [ ] All new tests pass
- [ ] All existing 1349 tests pass

---

## Risk Analysis

### Low Risk
- **Backwards compatible**: Undefined `platformLimit` is ignored (existing behavior)
- **Minimal code changes**: ~50 LOC in executor, ~40 LOC in scheduler
- **Isolated logic**: Platform limit detection is self-contained

### Medium Risk
- **Error message format dependency**: If OpenClaw changes error message format, parsing fails gracefully (undefined)
- **Module-level state**: `effectiveConcurrencyLimit` is module-scoped (acceptable for singleton scheduler)

### Mitigation
- Test coverage for various error formats
- Fallback to config cap if platform limit undefined
- Log when effective cap is adjusted (observability)

---

## Deliverables

1. **Design Document**: `~/Projects/AOF/docs/design/adaptive-concurrency.md` ✅
2. **Implementation Brief**: `/tmp/adaptive-concurrency-impl-brief.md` ✅
3. **This Summary**: `~/Projects/AOF/reports/adaptive-concurrency-summary.md` ✅

---

## Next Steps

1. Backend engineer implements changes per brief
2. Run test suite: `npx vitest run --reporter=dot`
3. Verify no regressions (1349 tests pass)
4. Commit with message: "feat: adaptive concurrency — detect OpenClaw platform limits"

---

## Estimated Timeline

- **Implementation**: 4 hours
- **Testing**: Included in implementation
- **Review**: 30 minutes

**Total**: ~5 hours

---

## Future Enhancements

- Backoff strategy on repeated platform limit hits
- Per-agent effective cap tracking
- UI visualization (dashboard showing effective vs. config cap)
- Dynamic adjustment of config.maxConcurrentDispatches based on historical platform limits
