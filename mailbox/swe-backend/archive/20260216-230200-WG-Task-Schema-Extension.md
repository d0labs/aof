# Task Brief: WG Extend Task Frontmatter Schema with Gate Fields

**Beads Task:** AOF-60p  
**Status:** Blocked by AOF-jax (Core schema types)  
**Estimated Effort:** Medium (M) — 3 hours max  
**Assigned To:** swe-backend

---

## Objective

Extend the Task frontmatter schema to include workflow gate fields. This adds gate state tracking to every task while maintaining backward compatibility.

## What to Build

Modify `src/schemas/task.ts` to add gate-related fields:

### 1. Import gate types

```typescript
import { GateHistoryEntry, ReviewContext, TestSpec } from "./gate.js";
```

### 2. Add GateState schema

```typescript
export const GateState = z.object({
  current: z.string().min(1),  // Current gate ID
  entered: z.string().datetime(),  // When task entered this gate
});
export type GateState = z.infer<typeof GateState>;
```

### 3. Extend TaskFrontmatter

```typescript
export const TaskFrontmatter = z.object({
  // ... existing fields ...
  
  // New: gate workflow state
  gate: GateState.optional(),
  gateHistory: z.array(GateHistoryEntry).default([]),
  reviewContext: ReviewContext.optional(),
  tests: z.array(TestSpec).default([]),
  testsFile: z.string().optional(),  // Reference to external test file
  
  // ... rest of existing fields ...
});
```

### 4. Update TaskRouting to include workflow reference

```typescript
export const TaskRouting = z.object({
  role: z.string().optional(),
  team: z.string().optional(),
  agent: z.string().optional(),
  tags: z.array(z.string()).default([]),
  
  // New: workflow reference
  workflow: z.string().optional(),  // Workflow name from project.yaml
});
```

## File Structure

```
src/schemas/task.ts (modify existing)
  - Import gate types from ./gate.js
  - Add GateState schema
  - Extend TaskFrontmatter with gate fields
  - Extend TaskRouting with workflow field
  - Ensure all fields are optional (backward compatible)
```

## Acceptance Criteria

1. ✅ GateState type defined
2. ✅ TaskFrontmatter extended with gate, gateHistory, reviewContext, tests, testsFile
3. ✅ TaskRouting extended with workflow field
4. ✅ All new fields are optional (backward compatible)
5. ✅ File compiles without errors (`npx tsc --noEmit`)
6. ✅ Existing tests pass (run `npx vitest run src/schemas/__tests__/` if tests exist)

## Dependencies

**Blocked by:**
- AOF-jax (Core schema types) — MUST complete first

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 2.1 for task frontmatter schema)
- Gate schema: `src/schemas/gate.ts` (created in AOF-jax)
- Existing task schema: `src/schemas/task.ts`

## Testing

No new tests required (schema extension only). Existing task store tests should still pass.

## Out of Scope

- Validation of gate transitions (handled in gate evaluator)
- Populating gateHistory (handled in scheduler)
- Workflow config schema (separate task: AOF-bko)

## Estimated Tests

0 (schema extension only, existing tests should pass)

---

**To claim this task:** `bd update AOF-60p --claim --json`  
**To complete:** `bd close AOF-60p --json`

**Note:** Do NOT start until AOF-jax is complete and merged.
