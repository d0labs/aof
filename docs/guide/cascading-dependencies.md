---
title: "Cascading Dependencies"
description: "How AOF automatically propagates task completions and blockings to dependent tasks."
---

AOF's dependency cascade system automatically propagates task state changes to downstream dependents. When a task completes (or blocks), all tasks that were waiting on it are immediately evaluated and potentially unblocked — without any polling or manual intervention.

## Declaring Dependencies

Tasks declare what they depend on via `dependsOn` in frontmatter:

```yaml
---
id: TASK-2026-02-21-003
title: Deploy auth service to staging
dependsOn:
  - TASK-2026-02-21-001   # Auth implementation
  - TASK-2026-02-21-002   # Integration tests pass
---
```

Task `003` will remain blocked until both `001` and `002` are in `done` state.

## Managing Dependencies via Tools

```json
// Add a dependency
{
  "tool": "aof_task_dep_add",
  "params": {
    "taskId": "TASK-2026-02-21-003",
    "blockerId": "TASK-2026-02-21-001",
    "actor": "swe-architect"
  }
}

// Remove a dependency
{
  "tool": "aof_task_dep_remove",
  "params": {
    "taskId": "TASK-2026-02-21-003",
    "blockerId": "TASK-2026-02-21-001",
    "actor": "swe-architect"
  }
}
```

## How the Cascade Works

```
TASK-001 completes (→ done)
        │
        ▼
dep-cascader.cascadeOnComplete("TASK-001")
        │
        ├── Load all tasks with dependsOn containing TASK-001
        │   → Found: TASK-003, TASK-004, TASK-007
        │
        ├── For each dependent: check ALL blockers
        │   TASK-003: depends on [001✓, 002✓] → ALL DONE → unblock
        │   TASK-004: depends on [001✓, 005✗] → still blocked
        │   TASK-007: depends on [001✓] → ALL DONE → unblock
        │
        └── Transition unblocked tasks: blocked → ready
            Emit dependency.unblocked events
```

## Cascade Modes

The dep-cascader handles two scenarios:

### On Completion (`cascadeOnComplete`)

When a task reaches `done`:
1. Find all tasks with this task in their `dependsOn`
2. For each dependent, check if ALL its `dependsOn` are now `done`
3. If all blockers are done: transition `blocked` → `ready`
4. Emit `dependency.unblocked` event

This is the **primary cascade path** — runs immediately on the completion hook in the protocol router.

### On Block (`cascadeOnBlock`)

When a task moves to `blocked`, optionally cascade the block to dependents:

```json
{
  "scheduler": {
    "cascadeBlocks": true    // default: false
  }
}
```

When `cascadeBlocks: true`:
- If Task A blocks, find all tasks that depend on A
- Mark them as `blocked` with reason "upstream task TASK-A is blocked"
- Prevents work from starting on tasks that will be stuck anyway

> **Note:** `cascadeBlocks` is opt-in and defaults to `false`. Enable it for strict dependency enforcement in workflows where upstream blocks should halt all downstream work.

## Scheduler Safety Net

In addition to the immediate cascade hook, the scheduler runs a **periodic dependency scan** on every poll cycle:

```
Poll cycle:
1. Scan all blocked tasks
2. For each blocked task, check dependsOn[]
3. If all blockers are done → transition to ready
```

This catches any cases the on-completion hook might have missed (e.g., tasks blocked before the cascade was added, manual state edits, etc.).

## Dependency Graph Example

```yaml
# Database migration (no deps)
TASK-001: title: "DB migration"
          status: done ✓

# API endpoint (depends on migration)
TASK-002: title: "Auth API"
          dependsOn: [TASK-001]
          status: done ✓

# Integration tests (depends on API)
TASK-003: title: "Integration tests"
          dependsOn: [TASK-002]
          status: done ✓

# Staging deploy (depends on API + tests)
TASK-004: title: "Deploy to staging"
          dependsOn: [TASK-002, TASK-003]
          status: blocked  ← becomes ready when 002+003 done

# Production deploy (depends on staging)
TASK-005: title: "Deploy to prod"
          dependsOn: [TASK-004]
          status: blocked  ← cascades when 004 done
```

When `TASK-003` completes:
1. `TASK-004` has all blockers done (`002✓` and `003✓`) → `ready`
2. On next scheduler cycle (or when `TASK-004` completes), `TASK-005` will be evaluated

## Circular Dependency Detection

The org linter checks for circular dependencies:

```bash
aof org lint
# ✗ Circular dependency detected: TASK-001 → TASK-003 → TASK-001
```

Circular deps will cause tasks to never unblock, so they're caught at lint time.

## CLI Commands

```bash
# Add a dependency
aof task dep add TASK-003 TASK-001

# Remove a dependency
aof task dep remove TASK-003 TASK-001

# Show dependencies for a task
aof task show TASK-003 --deps

# Lint for circular dependencies
aof org lint
```
