# Task Brief: WG Core Schema Types (Gate, GateTransition, GateOutcome)

**Beads Task:** AOF-jax  
**Status:** Ready (no blockers)  
**Estimated Effort:** Small (S) — 2 hours max  
**Assigned To:** swe-backend

---

## Objective

Define TypeScript types for Workflow Gates core primitives. These are pure type definitions with no logic — the foundation for all gate-related functionality.

## What to Build

Create `src/schemas/gate.ts` with the following type definitions:

### 1. GateOutcome
```typescript
export const GateOutcome = z.enum(["complete", "needs_review", "blocked"]);
export type GateOutcome = z.infer<typeof GateOutcome>;
```

### 2. Gate (workflow gate definition)
```typescript
export const Gate = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  canReject: z.boolean().default(false),
  when: z.string().optional(),
  description: z.string().optional(),
  requireHuman: z.boolean().optional(),
  timeout: z.string().optional(),  // e.g., "1h", "30m", "2h"
  escalateTo: z.string().optional(),
});
export type Gate = z.infer<typeof Gate>;
```

### 3. GateHistory (audit trail entry)
```typescript
export const GateHistoryEntry = z.object({
  gate: z.string(),
  role: z.string(),
  agent: z.string().optional(),
  entered: z.string().datetime(),
  exited: z.string().datetime().optional(),
  outcome: GateOutcome.optional(),
  summary: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  rejectionNotes: z.string().optional(),
  duration: z.number().int().nonnegative().optional(),
});
export type GateHistoryEntry = z.infer<typeof GateHistoryEntry>;
```

### 4. ReviewContext (feedback from previous rejection)
```typescript
export const ReviewContext = z.object({
  fromGate: z.string(),
  fromAgent: z.string().optional(),
  fromRole: z.string(),
  timestamp: z.string().datetime(),
  blockers: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type ReviewContext = z.infer<typeof ReviewContext>;
```

### 5. GateTransition (result of gate evaluation)
```typescript
export const GateTransition = z.object({
  taskId: z.string(),
  fromGate: z.string().optional(),
  toGate: z.string().optional(),
  outcome: GateOutcome,
  agent: z.string().optional(),
  timestamp: z.string().datetime(),
  duration: z.number().int().nonnegative().optional(),
  skipped: z.array(z.string()).default([]),  // Gates skipped due to conditionals
});
export type GateTransition = z.infer<typeof GateTransition>;
```

### 6. TestSpec (BDD-style test specification)
```typescript
export const TestSpec = z.object({
  given: z.string(),
  when: z.string(),
  then: z.object({
    status: z.number().int().optional(),
    body_contains: z.array(z.string()).optional(),
  }),
});
export type TestSpec = z.infer<typeof TestSpec>;
```

## File Structure

```
src/schemas/gate.ts
  - Import { z } from "zod"
  - Export all schemas and types
  - Add JSDoc comments for each type
```

## Acceptance Criteria

1. ✅ All types defined in `src/schemas/gate.ts`
2. ✅ All types use Zod for validation
3. ✅ All types exported with both schema and type
4. ✅ JSDoc comments explain purpose of each type
5. ✅ File compiles without errors (`npx tsc --noEmit`)
6. ✅ No logic or runtime code (types only)

## Dependencies

**None** — This is the foundation task.

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 2.1 for field definitions)
- Existing schema pattern: `src/schemas/project.ts` (follow this style)
- Task schema: `src/schemas/task.ts` (existing pattern reference)

## Testing

No tests required (this is just type definitions). Next task will add unit tests that use these types.

## Out of Scope

- Validation logic (comes later in gate evaluator)
- Integration with Task schema (next task: AOF-60p)
- Gate evaluation algorithm (separate task: AOF-acq)

## Estimated Tests

0 (type definitions only)

---

**To claim this task:** `bd update AOF-jax --claim --json`  
**To complete:** `bd close AOF-jax --json`
