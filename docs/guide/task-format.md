---
title: "Task Card Format"
description: "Task file structure, frontmatter schema, and field reference."
---

AOF task cards are Markdown files with YAML frontmatter. This document describes the recommended structure for task cards, including the Instructions vs Guidance distinction introduced in CTX-006.

## File Structure

```markdown
---
# Frontmatter (YAML)
schemaVersion: 1
id: TASK-YYYY-MM-DD-NNN
title: "Task title"
status: backlog
priority: normal
# ... other fields ...
instructionsRef: "inputs/instructions.md"  # optional
guidanceRef: "inputs/guidance.md"          # optional
---

# Task Title

## Instructions
What the agent should DO. Specific, actionable steps.

## Guidance
Conventions, constraints, patterns to follow. Context, not actions.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
```

## Frontmatter Fields

### Core Fields (Required)
- `schemaVersion`: Always `1` (for migration support)
- `id`: Stable task identifier (format: `TASK-YYYY-MM-DD-NNN`)
- `title`: Human-readable task title
- `status`: One of: `backlog`, `ready`, `in-progress`, `blocked`, `review`, `done`
- `priority`: One of: `critical`, `high`, `normal`, `low`
- `createdAt`: ISO-8601 timestamp
- `updatedAt`: ISO-8601 timestamp
- `lastTransitionAt`: ISO-8601 timestamp of last status change
- `createdBy`: Agent or system that created the task

### Optional Fields
- `instructionsRef`: Path to external instructions file (e.g., `"inputs/instructions.md"`)
- `guidanceRef`: Path to external guidance/conventions file (e.g., `"inputs/guidance.md"`)
- `requiredRunbook`: Required runbook path or ID for compliance
- `parentId`: Parent task ID for sub-task hierarchy
- `dependsOn`: Array of task IDs this depends on
- `contentHash`: SHA-256 of body content for idempotency
- `metadata`: Additional key-value metadata
- `lease`: Lease information when task is assigned
- `routing`: Routing hints for dispatcher
  - `role`: Target role from org chart
  - `team`: Target team from org chart
  - `agent`: Specific agent ID override
  - `tags`: Tags for capability-based matching

## Body Sections

### Instructions Section (Recommended)
The `## Instructions` section contains **actionable steps** — what the agent should do.

**Characteristics:**
- Imperative statements
- Specific, ordered steps
- References to inputs/outputs
- Clear completion criteria

**Example:**
```markdown
## Instructions

1. Update task schema in `src/schemas/task.ts`:
   - Add `instructionsRef?: string` field
   - Add `guidanceRef?: string` field
2. Create linter in `src/tools/task-linter.ts`
3. Add 10+ tests covering validation rules
4. Update documentation in `docs/task-format.md`
```

### Guidance Section (Optional, Required for Runbooks)
The `## Guidance` section contains **conventions and constraints** — context the agent should follow.

**Characteristics:**
- Declarative statements about principles
- Constraints and boundaries
- Coding style / architectural patterns
- "What not to do" warnings
- References to broader documentation

**Example:**
```markdown
## Guidance

- Follow TDD: write failing tests first
- Each module must be < 300 LOC
- No new dependencies without approval
- Backward compatible: all existing tasks must remain valid
- Use dispatch tables for conditional logic (see AGENTS.md)
```

### Other Common Sections
- `## Context`: Background information
- `## Acceptance Criteria`: Checklist of completion criteria
- `## Dependencies`: External dependencies or blockers
- `## Deliverables`: Expected outputs
- `## Testing`: Testing requirements
- `## Rollout`: Deployment/rollout plan

## Instructions vs Guidance: When to Use Each

| Aspect | Instructions | Guidance |
|--------|--------------|----------|
| **Purpose** | What to do | How to think about it |
| **Voice** | Imperative (commands) | Declarative (principles) |
| **Scope** | Task-specific | Reusable across tasks |
| **Example** | "Add field X to schema Y" | "Keep modules < 300 LOC" |
| **Required?** | Recommended for all tasks | Required for runbook-tagged tasks |

## External References

Instead of inline sections, you can use `instructionsRef` and `guidanceRef` to point to external files:

```yaml
---
id: TASK-2026-02-07-001
title: "Deploy new service"
instructionsRef: "inputs/deploy-instructions.md"
guidanceRef: "runbooks/deploy-guidance.md"
---
```

When using external references:
1. The body should still include `## Instructions` and `## Guidance` sections (summary or inline content)
2. The linter will warn if refs are set but sections are missing
3. The context assembler can pull in both inline and external content

## Validation Rules

The task linter (`src/tools/task-linter.ts`) enforces the following rules:

### Warnings (Backward Compatible)
- Missing `## Instructions` section → warning
- Empty `## Instructions` section → warning
- `instructionsRef` set but no `## Instructions` section → warning
- `guidanceRef` set but no `## Guidance` section → warning
- Empty `## Guidance` section when `guidanceRef` is set → warning

### Errors (Strict Mode)
Strict mode is enabled for:
- Tasks with `runbook` tag
- Tasks with `requiredRunbook` field

In strict mode:
- Missing `## Guidance` section → **error**

## Examples

### Minimal Valid Task (Backward Compatible)
```markdown
---
schemaVersion: 1
id: TASK-2026-02-07-001
title: "Fix bug in parser"
status: backlog
priority: normal
createdAt: "2026-02-07T19:00:00Z"
updatedAt: "2026-02-07T19:00:00Z"
lastTransitionAt: "2026-02-07T19:00:00Z"
createdBy: main
---

Fix the parser to handle edge case X.
```

### Recommended Task (With Instructions)
```markdown
---
schemaVersion: 1
id: TASK-2026-02-07-002
title: "Implement feature Y"
status: ready
priority: high
createdAt: "2026-02-07T19:00:00Z"
updatedAt: "2026-02-07T19:00:00Z"
lastTransitionAt: "2026-02-07T19:00:00Z"
createdBy: architect
---

## Instructions

1. Add schema field in `src/schemas/feature.ts`
2. Implement logic in `src/core/feature.ts`
3. Add tests in `src/core/__tests__/feature.test.ts`
4. Update docs in `docs/feature.md`

## Acceptance Criteria
- [ ] Schema updated
- [ ] Tests pass
- [ ] Docs updated
```

### Runbook Task (Requires Guidance)
```markdown
---
schemaVersion: 1
id: TASK-2026-02-07-003
title: "Deploy to production"
status: ready
priority: critical
routing:
  tags: ["runbook", "ops"]
requiredRunbook: "runbooks/production-deploy.md"
guidanceRef: "runbooks/deploy-guidance.md"
createdAt: "2026-02-07T19:00:00Z"
updatedAt: "2026-02-07T19:00:00Z"
lastTransitionAt: "2026-02-07T19:00:00Z"
createdBy: ops-lead
---

## Instructions

1. Run pre-deployment health check
2. Scale up canary instances
3. Monitor metrics for 15 minutes
4. Roll out to remaining fleet

## Guidance

- Zero downtime required
- Rollback if error rate > 0.1%
- Follow AWS Well-Architected Framework
- Coordinate with on-call SRE
- See full runbook: runbooks/production-deploy.md
```

## Migration from Legacy Format

Older tasks without `## Instructions` or `## Guidance` sections remain valid. The linter will emit warnings but not errors.

To migrate a legacy task:
1. Identify actionable steps → move to `## Instructions`
2. Identify conventions/constraints → move to `## Guidance`
3. Leave other sections unchanged

## Related Documentation
- `src/schemas/task.ts` — Task schema definition
- `src/tools/task-linter.ts` — Task linter implementation
- `src/store/task-store.ts` — Task parser with `extractTaskSections()`
- `AGENTS.md` — Agent coding directives and workflow
