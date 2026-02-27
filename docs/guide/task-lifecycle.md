---
title: "Task Lifecycle"
description: "How tasks move through AOF's state machine — from creation to completion."
---

How tasks move through AOF's state machine — from creation to completion.

## State Machine

```
                    ┌──────────┐
                    │  backlog  │  ◄── created here
                    └────┬─────┘
                         │ promote / ready
                    ┌────▼─────┐
                    │  ready   │  ◄── scheduler picks these up
                    └────┬─────┘
                         │ lease acquired + dispatch
               ┌─────────▼──────────┐
               │    in-progress     │  ◄── agent working, lease held
               └─────────┬──────────┘
                 ╔════════╩════════╗
        complete ║                 ║ needs review
                 ▼                 ▼
          ┌──────────┐     ┌───────────┐
          │   done   │     │  review   │  ◄── gate evaluation
          └──────────┘     └─────┬─────┘
                          approve│
                                 ▼
                          ┌──────────┐
                          │   done   │
                          └──────────┘

   At any point:
   in-progress/ready → blocked  (external dependency)
   any             → cancelled  (user/system cancellation)
   ready/in-progress → deadletter (3 failed dispatch attempts)
   deadletter      → ready      (resurrection)
```

## Valid Transitions

| From | To |
|------|----|
| `backlog` | `ready`, `blocked`, `cancelled` |
| `ready` | `in-progress`, `blocked`, `deadletter`, `cancelled` |
| `in-progress` | `review`, `ready`, `blocked`, `cancelled` |
| `blocked` | `ready`, `cancelled` |
| `review` | `done`, `in-progress`, `blocked`, `cancelled` |
| `done` | *(terminal)* |
| `cancelled` | *(terminal)* |
| `deadletter` | `ready` (via resurrection) |

## States in Detail

### `backlog`

The initial state for all newly created tasks. Tasks in `backlog` are not yet ready for dispatch — they may be waiting for:
- Triage / prioritization
- Dependencies to be identified
- Additional context to be added

Move to `ready` when the task is cleared for work.

### `ready`

Tasks in `ready` are queued for dispatch by the scheduler. On each poll cycle, the scheduler evaluates all `ready` tasks against:
- Agent availability and capacity
- `dependsOn` resolution (all dependencies must be `done`)
- SLA priority ordering
- Routing rules (org chart roles/tags/team)

When the scheduler selects a task, it:
1. Acquires a lease (sets `lease.agent`, `lease.acquiredAt`, `lease.expiresAt`)
2. Moves the file to `in-progress/` via atomic `rename()`
3. Dispatches the task to the agent

### `in-progress`

The agent holds a **lease** on the task. The lease has a TTL (default: 30 minutes, configurable via `defaultLeaseTtlMs`). If the agent fails to renew its heartbeat before the lease expires, the scheduler returns the task to `ready` for re-dispatch.

The lease is embedded in the task frontmatter:

```yaml
lease:
  agent: swe-backend
  acquiredAt: 2026-02-21T15:00:00Z
  expiresAt: 2026-02-21T15:30:00Z
  renewCount: 2
```

### `review`

When an agent completes its work but the task has workflow gates, it transitions to `review` instead of `done`. The gate evaluator routes it to the appropriate reviewer role.

In gate workflows:
- `outcome: "complete"` from the reviewer advances to the next gate or `done`
- `outcome: "needs_review"` rejects back to the origin gate (re-dispatch to implementing agent)
- `outcome: "blocked"` holds in the current gate

### `blocked`

Tasks blocked on external dependencies that AOF cannot resolve. Blocked tasks:
- Are not dispatched by the scheduler
- Must be manually unblocked or unblocked by the dep-cascader when blockers resolve
- Retain their `routing` so they re-dispatch to the same agent when unblocked

```yaml
metadata:
  blockedReason: "Waiting for security review to complete"
  blockedAt: "2026-02-21T15:00:00Z"
```

### `done`

Terminal state. Task completed successfully. All gate requirements satisfied.

### `cancelled`

Terminal state. Task abandoned. The `metadata.cancellationReason` field records why.

### `deadletter`

Tasks that failed dispatch 3 consecutive times land in `deadletter`. This indicates a systemic problem — agent not responding, routing misconfiguration, etc.

Deadlettered tasks require manual intervention:

```bash
# Inspect the task
aof task show TASK-2026-02-21-001

# Resurrect it
aof task resurrect TASK-2026-02-21-001
```

## The Scheduler

The scheduler runs on a configurable poll interval and drives all state transitions in the system:

```
Poll cycle:
1. Load all tasks/ directories (backlog, ready, in-progress, blocked, deadletter)
2. Check leases — expire any in-progress tasks past their TTL
3. Check SLAs — escalate overdue tasks
4. Evaluate dependencies — unblock tasks whose blockers are now done
5. Rank ready tasks by priority and SLA urgency
6. Acquire leases and dispatch (up to maxConcurrentDispatches)
7. Emit events for all mutations
```

Run manually:
```bash
aof scheduler run          # dry-run (no mutations)
aof scheduler run --active # active mode (mutates state)
```

Or as a daemon:
```bash
aof daemon start           # runs scheduler on pollIntervalMs
```

## Cascading Dependencies

When a task completes, AOF automatically unblocks dependent tasks:

```yaml
# Task B depends on Task A
dependsOn:
  - TASK-2026-02-21-001   # Task A
```

When Task A transitions to `done`, the dep-cascader:
1. Finds all tasks with `dependsOn` containing Task A's ID
2. Checks if ALL of those tasks' remaining blockers are also done
3. Transitions newly-unblocked tasks from `blocked` → `ready`
4. Emits a `dependency.unblocked` event

This is immediate (on-completion hook) plus a scheduler safety net (periodic scan). See [Cascading Dependencies](cascading-dependencies.md) for details.

## Leases and Heartbeats

Tasks in `in-progress` have an associated lease with a TTL. The dispatched agent must renew its heartbeat to keep the lease alive:

```json
{
  "tool": "aof_task_update",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "actor": "swe-backend"
  }
}
```

If the heartbeat lapses:
1. Scheduler detects expired lease on next poll
2. Task returns to `ready`
3. `lease.renewCount` is preserved for diagnostics
4. After 3 failures, task moves to `deadletter`

## Event Log

Every state transition emits a structured event to `events/events.jsonl`:

```json
{"timestamp":"2026-02-21T15:00:00Z","type":"task.created","taskId":"TASK-2026-02-21-001","actor":"cli"}
{"timestamp":"2026-02-21T15:01:00Z","type":"task.transitioned","taskId":"TASK-2026-02-21-001","from":"backlog","to":"ready","actor":"cli"}
{"timestamp":"2026-02-21T15:02:00Z","type":"task.dispatched","taskId":"TASK-2026-02-21-001","agent":"swe-backend","actor":"scheduler"}
{"timestamp":"2026-02-21T15:30:00Z","type":"task.completed","taskId":"TASK-2026-02-21-001","actor":"swe-backend"}
```

This log is append-only and can be used for audit, replay, and observability.

> **Tip:** Use `aof board` to visualize task states as a Kanban board, or `aof watch kanban` for a real-time view.
