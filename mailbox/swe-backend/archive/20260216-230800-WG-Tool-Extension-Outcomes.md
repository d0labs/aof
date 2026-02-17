# Task Brief: WG Extend aof_task_complete Tool with Outcomes

**Beads Task:** AOF-g89  
**Status:** Blocked by AOF-60p (Task schema extension)  
**Estimated Effort:** Small (S) — 2 hours max  
**Assigned To:** swe-backend

---

## Objective

Extend the `aof_task_complete` tool to accept outcome, blockers, and rejectionNotes parameters. Add a comprehensive self-teaching tool description that teaches agents correct usage without external docs.

## What to Build

Modify `src/tools/aof-tools.ts` to extend the tool interface:

### 1. Extend AOFTaskCompleteInput

```typescript
export interface AOFTaskCompleteInput {
  taskId: string;
  actor?: string;
  summary?: string;
  
  // New: gate outcome fields
  outcome?: "complete" | "needs_review" | "blocked";
  blockers?: string[];
  rejectionNotes?: string;
}
```

### 2. Update tool registration with self-teaching description

```typescript
// In MCP tool registration (src/mcp/server.ts or similar)
{
  name: "aof_task_complete",
  description: `Mark your current task as done.

**When to use:**
- You've finished your work and it's ready for the next step: set outcome to "complete"
- You found problems that need someone else to fix: set outcome to "needs_review" and list blockers
- You can't proceed due to external blockers: set outcome to "blocked" and explain why

**Parameters:**
- outcome (optional): "complete" | "needs_review" | "blocked"
  - "complete": Your work is done and ready to advance (default if omitted)
  - "needs_review": Work needs fixes - include specific blockers
  - "blocked": Can't proceed - external dependency or blocker
  
- summary (optional): Brief description of what you did (1-2 sentences)

- blockers (optional, array of strings): Specific issues that need fixing
  - Required if outcome is "needs_review" or "blocked"
  - Each blocker should be actionable (not vague)
  - Examples: "Missing error handling for expired tokens", "Test coverage at 65%, need 80%"
  
- rejectionNotes (optional, string): Additional context for the person fixing issues
  - Only relevant for "needs_review" outcome
  - Keep it constructive and specific

**Examples:**

Complete (implicit):
{
  "taskId": "AOF-abc",
  "summary": "Implemented JWT middleware with tests, 85% coverage"
}

Complete (explicit):
{
  "taskId": "AOF-abc",
  "outcome": "complete",
  "summary": "Implemented JWT middleware with tests, 85% coverage"
}

Needs Review (reviewer rejecting work):
{
  "taskId": "AOF-abc",
  "outcome": "needs_review",
  "summary": "Implementation needs revision before advancing",
  "blockers": [
    "Missing error handling for expired tokens",
    "Test coverage at 65%, target is 80%"
  ],
  "rejectionNotes": "Please address these issues and resubmit"
}

Blocked (can't proceed):
{
  "taskId": "AOF-abc",
  "outcome": "blocked",
  "summary": "Waiting for API spec from external team",
  "blockers": ["Need finalized API spec from platform team"]
}`,

  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Task ID to complete",
      },
      outcome: {
        type: "string",
        enum: ["complete", "needs_review", "blocked"],
        description: "Result of your work (default: complete)",
      },
      summary: {
        type: "string",
        description: "What you did (optional but recommended)",
      },
      blockers: {
        type: "array",
        items: { type: "string" },
        description: "Specific issues (required for needs_review/blocked)",
      },
      rejectionNotes: {
        type: "string",
        description: "Additional context for needs_review",
      },
      actor: {
        type: "string",
        description: "Agent ID (usually auto-populated)",
      },
    },
    required: ["taskId"],
  },
}
```

### 3. Backward compatibility handling

```typescript
export async function aofTaskComplete(
  ctx: ToolContext,
  input: AOFTaskCompleteInput
): Promise<AOFTaskCompleteResult> {
  const actor = input.actor ?? "unknown";
  const outcome = input.outcome ?? "complete";  // Default to complete
  
  // Resolve task
  const task = await resolveTask(ctx.store, input.taskId);
  
  // If task is in a gate workflow, use gate transition handler
  if (task.frontmatter.gate && outcome) {
    // Delegate to scheduler (implemented in AOF-9eq)
    const scheduler = ctx.scheduler;
    
    await scheduler.handleGateTransition(
      task.frontmatter.id,
      outcome,
      {
        summary: input.summary ?? "Completed",
        blockers: input.blockers,
        rejectionNotes: input.rejectionNotes,
        agent: actor,
      }
    );
    
    return {
      taskId: task.frontmatter.id,
      status: task.frontmatter.status,
      ...compactResponse(),
    };
  }
  
  // Backward compatible: non-gate tasks use existing completion logic
  // ... existing aofTaskComplete implementation ...
}
```

## File Structure

```
src/tools/aof-tools.ts (modify)
  - Extend AOFTaskCompleteInput interface
  - Update tool description (self-teaching)
  - Add backward-compatible handling
  - Default outcome to "complete" if omitted

src/mcp/server.ts (or wherever tools are registered)
  - Update tool registration with new description
```

## Acceptance Criteria

1. ✅ AOFTaskCompleteInput extended with outcome, blockers, rejectionNotes
2. ✅ Tool description is comprehensive and self-teaching (no external docs needed)
3. ✅ Backward compatible: omitting outcome defaults to "complete"
4. ✅ Non-gate tasks continue to work unchanged
5. ✅ File compiles without errors (`npx tsc --noEmit`)
6. ✅ Tool description includes examples for all outcomes

## Dependencies

**Blocked by:**
- AOF-60p (Task schema extension)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 4.1 for tool description)
- AOF tools: `src/tools/aof-tools.ts` (existing)
- MCP server: `src/mcp/server.ts` (tool registration)

## Testing

Manual testing with example completions. Validation tests in AOF-yt8 will cover error cases.

## Out of Scope

- Validation logic (separate task: AOF-yt8)
- Gate context injection (separate task: AOF-ofi)
- Telemetry (separate task: AOF-mmd)

## Estimated Tests

0 (manual testing only, validation covered in AOF-yt8)

---

**To claim this task:** `bd update AOF-g89 --claim --json`  
**To complete:** `bd close AOF-g89 --json`

**Note:** Do NOT start until AOF-60p is complete and merged.
