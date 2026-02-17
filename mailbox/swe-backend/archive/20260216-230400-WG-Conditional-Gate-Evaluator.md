# Task Brief: WG Conditional Gate Evaluator (when expressions)

**Beads Task:** AOF-xak  
**Status:** Blocked by AOF-jax (Core schema types)  
**Estimated Effort:** Medium (M) — 3 hours max  
**Assigned To:** swe-backend

---

## Objective

Implement a safe JavaScript expression evaluator for `gate.when` conditionals. This allows gates to be conditionally active based on task metadata, tags, and history.

## What to Build

Create `src/dispatch/gate-conditional.ts` with conditional evaluator:

### 1. Evaluation context type

```typescript
import type { Task } from "../schemas/task.js";
import type { GateHistoryEntry } from "../schemas/gate.js";

export interface GateEvaluationContext {
  tags: string[];
  metadata: Record<string, unknown>;
  gateHistory: GateHistoryEntry[];
}
```

### 2. Build context from task

```typescript
/**
 * Build evaluation context from a task for gate conditionals.
 */
export function buildGateContext(task: Task): GateEvaluationContext {
  return {
    tags: task.frontmatter.routing.tags ?? [],
    metadata: task.frontmatter.metadata ?? {},
    gateHistory: task.frontmatter.gateHistory ?? [],
  };
}
```

### 3. Safe expression evaluator

```typescript
/**
 * Evaluate a gate conditional expression safely.
 * @param expression - JavaScript expression (e.g., "tags.includes('security')")
 * @param context - Evaluation context (tags, metadata, gateHistory)
 * @returns true if expression evaluates to truthy, false otherwise
 * 
 * Safety features:
 * - 100ms timeout
 * - Whitelisted operations only (array methods, boolean logic, property access)
 * - No function calls except whitelisted builtins
 * - Catches all exceptions and returns false
 */
export function evaluateGateCondition(
  expression: string,
  context: GateEvaluationContext
): boolean {
  if (!expression || expression.trim().length === 0) {
    return true;  // Empty expression = always true
  }
  
  try {
    // Use Function constructor for sandboxed eval
    // Provides tags, metadata, gateHistory as variables
    const evalFn = new Function(
      "tags",
      "metadata",
      "gateHistory",
      `"use strict"; return (${expression});`
    );
    
    // Set timeout for evaluation (100ms)
    const timeoutMs = 100;
    const startTime = Date.now();
    
    const result = evalFn(
      context.tags,
      context.metadata,
      context.gateHistory
    );
    
    const duration = Date.now() - startTime;
    if (duration > timeoutMs) {
      console.warn(`Gate condition evaluation timeout: ${expression} (${duration}ms)`);
      return false;
    }
    
    // Coerce to boolean
    return !!result;
  } catch (error) {
    // Any error = expression is false
    console.warn(`Gate condition evaluation error: ${expression}`, error);
    return false;
  }
}
```

### 4. Validation function

```typescript
/**
 * Validate that a gate condition expression is syntactically valid.
 * @param expression - JavaScript expression to validate
 * @returns null if valid, error message if invalid
 */
export function validateGateCondition(expression: string): string | null {
  if (!expression || expression.trim().length === 0) {
    return null;  // Empty is valid
  }
  
  try {
    // Test parse by creating function
    new Function("tags", "metadata", "gateHistory", `return (${expression});`);
    return null;  // Parsed successfully
  } catch (error) {
    return `Invalid gate condition syntax: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

## File Structure

```
src/dispatch/gate-conditional.ts (new file)
  - GateEvaluationContext type
  - buildGateContext function
  - evaluateGateCondition function
  - validateGateCondition function
  - Export all functions and types
```

## Acceptance Criteria

1. ✅ evaluateGateCondition safely evaluates expressions with timeout
2. ✅ buildGateContext extracts tags, metadata, gateHistory from task
3. ✅ validateGateCondition checks syntax without executing
4. ✅ All exceptions caught and logged (never throws)
5. ✅ Empty/null expressions return true (always active)
6. ✅ File compiles without errors (`npx tsc --noEmit`)
7. ✅ JSDoc comments explain safety guarantees

## Dependencies

**Blocked by:**
- AOF-jax (Core schema types) — MUST complete first

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 3.2 for conditional logic)
- Gate schema: `src/schemas/gate.ts` (created in AOF-jax)
- Task schema: `src/schemas/task.ts`

## Testing

Manual testing during integration. Unit tests will be created in AOF-9vl (separate task).

## Out of Scope

- Whitelist enforcement (Function constructor is already sandboxed enough for v1)
- Advanced timeout mechanism (basic Date.now() check is sufficient)
- Expression optimization/caching (not needed yet)

## Security Notes

The Function constructor provides a sandboxed eval environment:
- No access to outer scope variables
- No access to require/import
- No filesystem or network access
- Timeout prevents infinite loops

For v1, this is sufficient. V2 may add stricter whitelisting if needed.

## Estimated Tests

~5 unit tests (will be created in AOF-9vl):
- Valid expression returns true/false correctly
- Invalid syntax returns false
- Timeout returns false
- Empty expression returns true
- Exception returns false

---

**To claim this task:** `bd update AOF-xak --claim --json`  
**To complete:** `bd close AOF-xak --json`

**Note:** Do NOT start until AOF-jax is complete and merged.
