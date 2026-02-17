# AOF Bug Fixes — Implementation Complete

**Date:** 2026-02-15 18:29 EST  
**Engineer:** swe-backend (subagent)  
**Source Brief:** /tmp/aof-bug-fixes-backend.md

## Summary

All 3 P1 bug fixes found during Mule integration testing have been **verified as already implemented and tested**. The architect had already implemented the fixes as part of the root cause analysis.

## Bug Fixes Verified

### Bug 2: AOF-dov — "Invalid transition: ready → ready" on lease expiry ✅

**Status:** Already fixed and tested  
**Location:** `src/store/task-store.ts` (lines 399-402)  
**Test:** `src/store/__tests__/task-store.test.ts` — "makes transition idempotent (no error on same status)"

**Implementation:**
```typescript
// Idempotent: if already in target state, return early (no-op)
if (currentStatus === newStatus) {
  return task;
}
```

The transition method now returns early without error when attempting to transition to the same status, preventing the "Invalid transition: ready → ready" error when lease expiry tries to requeue a task that's already in ready.

---

### Bug 1: AOF-6uz — Dispatched agents don't mark tasks as done ✅

**Status:** Already fixed and tested  
**Location:** `src/openclaw/openclaw-executor.ts` (lines 266-287, `formatTaskInstruction()`)  
**Test:** `src/openclaw/__tests__/executor.test.ts` — "includes aof_task_complete instruction with taskId"

**Implementation:**
The `formatTaskInstruction()` method now includes explicit instructions:
```typescript
**IMPORTANT:** When you have completed this task, call the `aof_task_complete` tool with taskId="${context.taskId}" to mark it as done.
```

This ensures spawned agents know to call `aof_task_complete` with the taskId when work is finished, preventing infinite re-dispatch loops.

---

### Bug 3: AOF-x1o — Scheduler only dispatches to swe-architect ✅

**Status:** Already fixed and tested  
**Location:** `src/openclaw/openclaw-executor.ts` (lines 82-118)  
**Tests:** 
- "normalizes agent ID by trying multiple formats"
- "handles graceful fallback when agent not found in any format"

**Implementation:**
- `normalizeAgentId()` method (lines 82-91) returns multiple agent ID formats to try
- HTTP dispatch loop (lines 37-57) tries all formats sequentially
- `spawnAgentFallbackWithNormalization()` (lines 93-118) tries all formats with graceful fallback

Agent ID normalization tries:
1. Raw agent value (e.g., "swe-backend")
2. Full format (e.g., "agent:swe-backend:main")

If all formats fail, logs warning and leaves task in ready (graceful fallback instead of error).

---

## Test Results

**Full test suite run:** All tests passing  
**Total tests:** 1341 passed | 3 skipped (1344)  
**Duration:** 29.70s

### Relevant test results:
- ✅ `src/store/__tests__/task-store.test.ts` — "makes transition idempotent (no error on same status)"
- ✅ `src/openclaw/__tests__/executor.test.ts` — "includes aof_task_complete instruction with taskId"
- ✅ `src/openclaw/__tests__/executor.test.ts` — "normalizes agent ID by trying multiple formats"
- ✅ `src/openclaw/__tests__/executor.test.ts` — "handles graceful fallback when agent not found in any format"

---

## Beads Closed

All three beads have been closed successfully:

1. ✅ **AOF-dov** — "Invalid transition: ready → ready" on lease expiry
2. ✅ **AOF-6uz** — Dispatched agents don't mark tasks as done
3. ✅ **AOF-x1o** — Scheduler only dispatches to swe-architect

---

## Conclusion

All P1 bug fixes from Mule integration testing are confirmed as implemented, tested, and verified. The codebase already contains:

- Idempotent state transitions
- Task completion instructions for spawned agents
- Agent ID normalization with graceful fallbacks

No additional code changes were required. All tests pass.
