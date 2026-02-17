# Task Brief: WG Validation Errors + Helpful Messages

**Beads Task:** AOF-yt8  
**Status:** Blocked by AOF-g89 (tool extension)  
**Estimated Effort:** Small (S) — 2 hours max  
**Assigned To:** swe-backend

---

## Objective

Add a validation layer to `aof_task_complete` that returns **actionable, teaching error messages** for invalid usage (bad outcomes, missing summary, missing blockers, vague blockers, wrong task). This implements the design’s “helpful errors” ladder.

## What to Build

Modify `src/tools/aof-tools.ts` (and any shared validation helpers) to validate completion inputs **before** routing to gate logic.

### 1. Add validation helper

Create a helper function near `aofTaskComplete`:

```typescript
export interface CompletionValidationError {
  code: string;
  message: string;
}

export function validateCompletionInput(input: AOFTaskCompleteInput): CompletionValidationError | null {
  // Validate outcome
  // Validate summary
  // Validate blockers requirements
  // Validate blockers content (non-empty, actionable)
  return null;
}
```

### 2. Required validation cases (with exact messages)

- **Invalid outcome**
  - Message: `Invalid outcome "{outcome}". Valid outcomes: "complete", "needs_review", "blocked". Use "complete" if your work is finished.`

- **Missing summary**
  - Message: `Missing required field "summary". Please include a 1-2 sentence description of what you did.`

- **Missing blockers when outcome = needs_review/blocked**
  - Message: `Outcome "{outcome}" requires "blockers". List specific issues that need fixing (e.g., ["Missing error handling", "Test coverage at 65%"]).`

- **Empty blockers array**
  - Message: `"blockers" is an empty array. If outcome is "needs_review" or "blocked", list at least one specific issue.`

- **Vague blocker** (basic heuristic)
  - If any blocker is too short or matches a vague set (e.g., "needs work", "fix", "bad"), return:
  - Message: `Blocker "{blocker}" is too vague. Be specific: what exactly needs fixing? Example: "Missing error handling for timeout edge case".`

- **Wrong task** (if taskId doesn’t match assigned task in context)
  - Message: `You're trying to complete task {input.taskId} but you're assigned to {currentTaskId}. Did you mean to complete {currentTaskId}?`

### 3. Error handling path

- If validation fails, throw a **ToolError** (or equivalent) with the message above.
- Ensure error surfaces to agent **without** stack trace noise.

## File Structure

```
src/tools/aof-tools.ts (modify)
  - validateCompletionInput helper
  - Guard clauses inside aofTaskComplete
  - Return/throw with clear error messages
```

## Acceptance Criteria

1. ✅ Invalid outcomes return the exact teaching error message
2. ✅ Missing/empty blockers are rejected with actionable guidance
3. ✅ Missing summary returns required message
4. ✅ Vague blockers are rejected with example guidance
5. ✅ Wrong-task completion is rejected with corrective message
6. ✅ No validation errors leak stack traces to agents
7. ✅ All existing tests pass (`npx vitest run src/tools/__tests__/` if any)

## Dependencies

**Blocked by:**
- AOF-g89 (Extend aof_task_complete tool with outcomes)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 5.4 error catalog)
- Tool handler: `src/tools/aof-tools.ts`

## Testing

Add/update unit tests if needed (covered in AOF-27d integration tests). Spot-check with a local tool call.

## Out of Scope

- Gate transition logic (AOF-9eq)
- Tool description changes (AOF-g89)

## Estimated Tests

2–4 unit tests (invalid outcome, missing blockers, vague blocker)

---

**To claim this task:** `bd update AOF-yt8 --claim --json`  
**To complete:** `bd close AOF-yt8 --json`
