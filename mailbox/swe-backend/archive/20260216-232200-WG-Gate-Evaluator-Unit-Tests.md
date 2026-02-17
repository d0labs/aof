# Task Brief: WG Unit Tests for Gate Evaluator

**Beads Task:** AOF-9vl  
**Status:** Blocked by AOF-acq + AOF-xak  
**Estimated Effort:** Small (S) — 2 hours max  
**Assigned To:** swe-backend

---

## Objective

Add unit tests covering the gate evaluator and conditional logic to ensure deterministic routing and safe expression handling.

## What to Build

Create `src/dispatch/__tests__/gate-evaluator.test.ts` (or similar) with focused unit tests:

### Required test cases

1. **Complete → advance**
   - Given current gate, outcome `complete`, next gate is selected.

2. **Complete → skip conditional**
   - Given next gate with `when` false, evaluator skips to next active gate.

3. **Needs_review → rejection**
   - Outcome `needs_review` routes to first gate and attaches reviewContext.

4. **Blocked → hold**
   - Outcome `blocked` keeps gate/current role unchanged.

5. **Invalid current gate**
   - Returns/throws clear error when task.gate.current not found in workflow.

6. **Conditional eval errors**
   - Invalid `when` expression is treated as false (skip gate).

## File Structure

```
src/dispatch/__tests__/gate-evaluator.test.ts (new)
  - Use in-memory task + workflow fixtures
  - Import evaluator from AOF-acq and conditional evaluator from AOF-xak
```

## Acceptance Criteria

1. ✅ All tests pass under `npx vitest run src/dispatch/__tests__/gate-evaluator.test.ts`
2. ✅ Tests cover complete/needs_review/blocked outcomes
3. ✅ Tests cover conditional gate skip logic
4. ✅ Tests cover invalid current gate handling

## Dependencies

**Blocked by:**
- AOF-acq (Gate evaluation algorithm)
- AOF-xak (Conditional gate evaluator)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 3.1/3.2)
- Gate evaluator: `src/dispatch/gate-evaluator.ts` (AOF-acq)
- Conditional evaluator: `src/dispatch/gate-conditional.ts` (AOF-xak)

## Testing

This task is tests-only.

## Out of Scope

- Scheduler integration tests (AOF-27d)
- Timeout/auto-escalation tests (AOF-69l)

## Estimated Tests

~6 unit tests

---

**To claim this task:** `bd update AOF-9vl --claim --json`  
**To complete:** `bd close AOF-9vl --json`
