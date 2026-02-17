# Task Brief: WG Workflow Config Schema + Validation

**Beads Task:** AOF-bko  
**Status:** Blocked by AOF-jax (Core schema types)  
**Estimated Effort:** Medium (M) — 3 hours max  
**Assigned To:** swe-backend

---

## Objective

Define the Workflow configuration schema for `project.yaml`. This allows projects to define multi-stage workflows with gates, rejection strategies, and conditional logic.

## What to Build

Create `src/schemas/workflow.ts` with workflow configuration schema:

### 1. Import gate types

```typescript
import { z } from "zod";
import { Gate } from "./gate.js";
```

### 2. RejectionStrategy enum

```typescript
export const RejectionStrategy = z.enum(["origin"]);  // v1: only "origin" supported
export type RejectionStrategy = z.infer<typeof RejectionStrategy>;
```

### 3. WorkflowConfig schema

```typescript
export const WorkflowConfig = z.object({
  name: z.string().min(1),
  rejectionStrategy: RejectionStrategy.default("origin"),
  gates: z.array(Gate).min(1),  // At least one gate required
  outcomes: z.record(z.string(), z.string()).optional(),  // Optional outcome descriptions
});
export type WorkflowConfig = z.infer<typeof WorkflowConfig>;
```

### 4. Validation function

```typescript
/**
 * Validate workflow config for internal consistency.
 * @param workflow - Workflow config to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateWorkflow(workflow: WorkflowConfig): string[] {
  const errors: string[] = [];
  
  // First gate cannot reject (nowhere to loop back to)
  if (workflow.gates.length > 0 && workflow.gates[0].canReject) {
    errors.push("First gate cannot have canReject=true (no previous gate to return to)");
  }
  
  // Gate IDs must be unique
  const gateIds = new Set<string>();
  for (const gate of workflow.gates) {
    if (gateIds.has(gate.id)) {
      errors.push(`Duplicate gate ID: ${gate.id}`);
    }
    gateIds.add(gate.id);
  }
  
  // Timeout must be valid duration format (e.g., "1h", "30m")
  const durationRegex = /^\d+[mh]$/;
  for (const gate of workflow.gates) {
    if (gate.timeout && !durationRegex.test(gate.timeout)) {
      errors.push(`Invalid timeout format for gate ${gate.id}: ${gate.timeout} (expected: "1h", "30m", etc.)`);
    }
  }
  
  // If gate has escalateTo, it must reference a role (can't validate against org chart here)
  for (const gate of workflow.gates) {
    if (gate.escalateTo && gate.escalateTo.trim().length === 0) {
      errors.push(`Gate ${gate.id} has empty escalateTo role`);
    }
  }
  
  return errors;
}
```

### 5. Extend ProjectManifest schema

Modify `src/schemas/project.ts` to include workflow:

```typescript
export const ProjectManifest = z.object({
  // ... existing fields ...
  
  // New: workflow configuration
  workflow: WorkflowConfig.optional(),
});
```

## File Structure

```
src/schemas/workflow.ts (new file)
  - RejectionStrategy enum
  - WorkflowConfig schema
  - validateWorkflow function
  - Export all schemas and types

src/schemas/project.ts (modify)
  - Import WorkflowConfig from ./workflow.js
  - Add workflow field to ProjectManifest
```

## Acceptance Criteria

1. ✅ WorkflowConfig schema defined in `src/schemas/workflow.ts`
2. ✅ validateWorkflow function implemented with all checks
3. ✅ ProjectManifest extended with optional workflow field
4. ✅ All validation rules enforced (first gate, unique IDs, timeout format)
5. ✅ File compiles without errors (`npx tsc --noEmit`)
6. ✅ Self-documenting JSDoc comments on all exports

## Dependencies

**Blocked by:**
- AOF-jax (Core schema types) — MUST complete first

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 2.2 for workflow schema)
- Gate schema: `src/schemas/gate.ts` (created in AOF-jax)
- Project schema: `src/schemas/project.ts` (existing)

## Testing

No tests required yet (validation will be tested in integration tests). The validateWorkflow function will be covered by workflow loading tests.

## Out of Scope

- Conditional expression parsing (handled in AOF-xak)
- Role validation against org chart (handled at config load time, not schema)
- Gate evaluation logic (separate task: AOF-acq)

## Estimated Tests

0 (schema definition + simple validation)

---

**To claim this task:** `bd update AOF-bko --claim --json`  
**To complete:** `bd close AOF-bko --json`

**Note:** Do NOT start until AOF-jax is complete and merged.
