# AOF-69l: Gate Timeout Detection + Auto-Escalation - Implementation Complete

**Status:** ✅ COMPLETE  
**Task:** AOF-69l  
**Date:** 2026-02-17

## Summary

Implemented gate timeout detection and auto-escalation for workflow gates. The scheduler now monitors in-progress tasks with gate workflows and automatically escalates to the configured `escalateTo` role when a gate timeout is exceeded.

## Implementation

### Files Created

1. **`src/dispatch/duration-parser.ts`** (NEW)
   - Parses duration strings ("1h", "30m", "2h") to milliseconds
   - Returns null for invalid formats
   - Rejects zero and negative values
   - Fully tested with 5 test cases

2. **`src/dispatch/__tests__/gate-timeout.test.ts`** (NEW)
   - Duration parser tests (5 passing)
   - Gate timeout detection tests (5 passing)
   - Total: 10 tests, all passing

### Files Modified

1. **`src/dispatch/scheduler.ts`**
   - Added `loadProjectManifest()` helper function
   - Added `checkGateTimeouts()` function (polls in-progress tasks for timeouts)
   - Added `escalateGateTimeout()` function (handles timeout escalation)
   - Integrated into poll loop as section 3.9
   - Added import for `parseDuration`

2. **`src/schemas/event.ts`**
   - Added `"gate_timeout"` event type
   - Added `"gate_timeout_escalation"` event type

## Algorithm

The timeout checker runs during each scheduler poll:

1. Scans all in-progress tasks
2. Filters for tasks with gate workflow (`gate` field present)
3. Loads project manifest to get workflow configuration
4. Finds current gate and checks for `timeout` configuration
5. Parses timeout duration string (e.g., "1h" → 3600000ms)
6. Compares `now - gate.entered` against timeout
7. If exceeded:
   - **With `escalateTo`:** Updates task routing to escalation role, appends gate history, emits `gate_timeout_escalation` event
   - **Without `escalateTo`:** Logs warning, emits `gate_timeout` event (no-op escalation)

## Timeout Values (from design)

Default timeouts per gate type:
- **Review gates** (code-review, qa, security, docs, po-accept): 1 hour
- **Implementation gate**: 2 hours
- **Ready-check**: 30 minutes
- **Deploy**: 45 minutes

Projects define these in `project.yaml`:

```yaml
workflow:
  gates:
    - id: review
      role: swe-qa
      timeout: "1h"
      escalateTo: swe-pm
```

## Testing

### Unit Tests
- ✅ Duration parser handles all valid formats (minutes, hours)
- ✅ Duration parser rejects invalid formats
- ✅ Timeout detection escalates to configured role
- ✅ Timeout detection logs warning when no escalateTo
- ✅ Ignores tasks without gate
- ✅ Ignores tasks within timeout window
- ✅ Handles invalid timeout format gracefully

### Integration
- ✅ All 1484 tests pass (146 test files)
- ✅ TypeScript compiles without errors
- ✅ No regressions in existing tests

## Behavior

**V1 (this implementation):**
- Simple timeout detection + escalation
- No cascading (2x timeout → PM, 3x → dead-letter)
- No smart retry logic

**Future V2 (out of scope):**
- Cascading escalation (multiple timeout tiers)
- Smarter escalation strategies
- Timeout history tracking beyond gate history

## Files Changed

### Production Code
1. `src/dispatch/duration-parser.ts` (NEW, 29 lines)
2. `src/dispatch/scheduler.ts` (+194 lines)
3. `src/schemas/event.ts` (+2 lines)

### Test Code
1. `src/dispatch/__tests__/gate-timeout.test.ts` (NEW, 298 lines)

## Acceptance Criteria

- ✅ checkGateTimeouts scans in-progress tasks for gate timeouts
- ✅ Timeouts trigger escalation to escalateTo role
- ✅ History entry appended with timeout details
- ✅ Event logged for observability
- ✅ parseDuration handles "1h", "30m", "2h" formats
- ✅ Invalid duration formats logged as warnings
- ✅ File compiles without errors (`npx tsc --noEmit`)
- ✅ Backward compatible (non-gate tasks unaffected)

## TDD Approach

1. ✅ Wrote duration parser tests first
2. ✅ Implemented duration parser to pass tests
3. ✅ Wrote gate timeout detection tests
4. ✅ Implemented timeout detection to pass tests
5. ✅ Verified full test suite still passes

Test Results:
```
Test Files  146 passed (146)
Tests       1484 passed (1484)
Duration    25.27s
```

## Task Status

- **Claimed:** 2026-02-16 23:59 EST
- **Completed:** 2026-02-17 00:05 EST
- **Duration:** ~6 minutes
- **Beads Status:** CLOSED

## Notes

- Implementation kept deliberately simple ("dumb") as specified
- No smart escalation strategies in V1
- All timeout logic isolated in scheduler.ts
- Duration parser is reusable for other timeout scenarios
- Events logged to `events.jsonl` for observability
- Dry-run mode respects task mutations (doesn't escalate in dry-run)
