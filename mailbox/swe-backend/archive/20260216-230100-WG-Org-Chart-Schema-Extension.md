# Task Brief: WG Org Chart Schema Extension for Gates

**Beads Task:** AOF-snk  
**Status:** Ready (no blockers)  
**Estimated Effort:** Small (S) — 2 hours max  
**Assigned To:** swe-backend

---

## Objective

Extend the org chart schema (`org-chart.ts`) to support role-based agent mapping for workflow gates. This allows workflows to reference abstract roles (e.g., "backend", "architect") that map to concrete agents.

## What to Build

Modify `src/schemas/org-chart.ts` to add role-based agent mapping:

### 1. Add RoleMapping type

```typescript
export const RoleMapping = z.object({
  agents: z.array(z.string()).min(1),  // At least one agent per role
  description: z.string().optional(),
  requireHuman: z.boolean().optional(),  // D3: human-only roles
});
export type RoleMapping = z.infer<typeof RoleMapping>;
```

### 2. Extend OrgChart schema

```typescript
export const OrgChart = z.object({
  // ... existing fields (teams, etc.) ...
  
  // New: role-based agent mapping for gates
  roles: z.record(z.string(), RoleMapping).optional(),
});
```

### 3. Add validation function

```typescript
/**
 * Validate that all roles referenced in a workflow exist in the org chart.
 * @param workflow - Workflow config with gates
 * @param orgChart - Org chart with role mappings
 * @returns Array of validation errors (empty if valid)
 */
export function validateWorkflowRoles(
  workflow: { gates: Array<{ role: string; escalateTo?: string }> },
  orgChart: { roles?: Record<string, RoleMapping> }
): string[] {
  const errors: string[] = [];
  const roles = orgChart.roles ?? {};
  
  for (const gate of workflow.gates) {
    if (!roles[gate.role]) {
      errors.push(`Gate references undefined role: ${gate.role}`);
    }
    if (gate.escalateTo && !roles[gate.escalateTo]) {
      errors.push(`Gate escalateTo references undefined role: ${gate.escalateTo}`);
    }
  }
  
  return errors;
}
```

## File Structure

```
src/schemas/org-chart.ts (modify existing)
  - Add RoleMapping schema
  - Extend OrgChart schema with roles field
  - Add validateWorkflowRoles helper function
  - Export new types
```

## Acceptance Criteria

1. ✅ RoleMapping type defined with Zod schema
2. ✅ OrgChart schema extended with optional `roles` field
3. ✅ validateWorkflowRoles function implemented
4. ✅ All new exports added to schema exports
5. ✅ File compiles without errors (`npx tsc --noEmit`)
6. ✅ Backward compatible (existing org charts without `roles` still valid)

## Dependencies

**None** — This task is independent.

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 6.3 for org chart integration)
- Existing org chart schema: `src/schemas/org-chart.ts`
- Example org chart: See Section 6.3.5 in design doc

## Testing

No tests required yet (validation will be tested in integration tests). The validateWorkflowRoles function is simple and will be covered by workflow validation tests.

## Out of Scope

- Scheduler routing logic (handled in AOF-9eq)
- Load balancing strategy (round-robin) — deferred to scheduler
- Human-only enforcement (enforcement logic in completion handler, not schema)

## Estimated Tests

0 (type definitions + simple validation function)

---

**To claim this task:** `bd update AOF-snk --claim --json`  
**To complete:** `bd close AOF-snk --json`
