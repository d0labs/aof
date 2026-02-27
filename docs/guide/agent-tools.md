---
title: "Agent Tools Reference"
description: "Complete reference for all AOF tools available to agents — parameters, types, and examples."
---

AOF exposes a set of tools to agents via MCP (Model Context Protocol) or the OpenClaw gateway. These tools are the primary API for agents to interact with the task system.

> **Tip:** All tools accept an optional `actor` parameter identifying the calling agent. Always supply this — it's used for audit logging, event attribution, and gate role enforcement.

## aof_dispatch

Create and dispatch a new task to the ready queue.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | Short task title (shown in board/mailbox views) |
| `brief` | string | yes | Task description / body (Markdown supported) |
| `agent` | string | — | Target agent ID (bypasses org chart routing) |
| `team` | string | — | Target team ID |
| `role` | string | — | Target role from org chart roles mapping |
| `priority` | enum | — | `"low"` \| `"normal"` \| `"high"` \| `"critical"` (default: `"normal"`) |
| `dependsOn` | string[] | — | Task IDs this task depends on |
| `parentId` | string | — | Parent task ID for sub-task hierarchy |
| `tags` | string[] | — | Tags for capability-based routing |
| `metadata` | object | — | Arbitrary key-value metadata |
| `actor` | string | — | Calling agent ID (for attribution) |

**Returns:**

```typescript
{
  taskId: string;      // Assigned task ID (e.g., "TASK-2026-02-21-001")
  status: TaskStatus;  // Initial status ("ready" or "backlog")
  filePath: string;    // Filesystem path of the task file
}
```

**Example:**

```json
{
  "tool": "aof_dispatch",
  "params": {
    "title": "Implement JWT refresh token endpoint",
    "brief": "Add POST /auth/refresh endpoint that accepts a refresh token and returns a new access token.\n\n## Acceptance Criteria\n- [ ] Validates refresh token signature\n- [ ] Returns new access + refresh token pair\n- [ ] Invalidates old refresh token (rotation)\n- [ ] Tests: 8+ covering success + failure cases",
    "agent": "swe-backend",
    "priority": "high",
    "tags": ["auth", "api"],
    "actor": "swe-architect"
  }
}
```

**Response:**

```json
{
  "taskId": "TASK-2026-02-21-001",
  "status": "ready",
  "filePath": "tasks/ready/TASK-2026-02-21-001.md"
}
```

---

## aof_task_complete

Mark a task as complete. For gated tasks, advance or reject the current gate.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID or ID prefix |
| `summary` | string | — | Completion summary / work log entry |
| `outcome` | enum | yes (gated) | `"complete"` \| `"needs_review"` \| `"blocked"` |
| `blockers` | string[] | yes (when outcome=needs_review or blocked) | Issues preventing progress |
| `callerRole` | string | recommended | Declared role for gate enforcement |
| `actor` | string | — | Calling agent ID |

**Outcomes for gated tasks:**

| Outcome | Effect |
|---------|--------|
| `"complete"` | Advance to next gate, or move to `done` if final gate |
| `"needs_review"` | Reject back to origin gate; requires `blockers` |
| `"blocked"` | Hold in current gate; requires `blockers` |

**Returns:**

```typescript
{
  taskId: string;
  status: TaskStatus;   // New status after transition
}
```

**Examples:**

Standard task completion (no gate):
```json
{
  "tool": "aof_task_complete",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "summary": "Implemented JWT refresh token rotation. 12 tests passing.",
    "actor": "swe-backend"
  }
}
```

Gate completion — advance:
```json
{
  "tool": "aof_task_complete",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "outcome": "complete",
    "summary": "Feature implemented with full test coverage",
    "actor": "swe-backend",
    "callerRole": "developer"
  }
}
```

Gate rejection — send back for fixes:
```json
{
  "tool": "aof_task_complete",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "outcome": "needs_review",
    "blockers": [
      "Token rotation not implemented (old token remains valid)",
      "Missing test for concurrent refresh requests"
    ],
    "summary": "Needs fixes before approval",
    "actor": "swe-architect",
    "callerRole": "reviewer"
  }
}
```

---

## aof_task_update

Update a task's status or body without completing it. Use for status changes, heartbeat renewals, and work log entries.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID or prefix |
| `body` | string | — | New body content (replaces existing) |
| `status` | enum | — | New status (must be a valid transition) |
| `reason` | string | — | Reason for status change (logged to events) |
| `actor` | string | — | Calling agent ID |

**Returns:**

```typescript
{
  taskId: string;
  status: TaskStatus;
  updatedAt: string;      // ISO-8601
  bodyUpdated: boolean;
  transitioned: boolean;
}
```

**Example (heartbeat / work log):**

```json
{
  "tool": "aof_task_update",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "body": "# Objective\nImplement JWT refresh.\n\n## Work Log\n- 15:00 Started implementation\n- 15:30 Core logic done, writing tests\n- 16:00 Tests passing, finalizing",
    "actor": "swe-backend"
  }
}
```

---

## aof_task_edit

Edit task metadata: title, description, priority, or routing.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID or prefix |
| `title` | string | — | New title |
| `description` | string | — | New description (Markdown) |
| `priority` | enum | — | `"low"` \| `"normal"` \| `"high"` \| `"critical"` |
| `routing` | object | — | `{ role?, team?, agent?, tags? }` |
| `actor` | string | — | Calling agent ID |

**Returns:**

```typescript
{
  taskId: string;
  updatedFields: string[];   // Which fields changed
  task: {
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
  };
}
```

**Example:**

```json
{
  "tool": "aof_task_edit",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "priority": "critical",
    "routing": {
      "agent": "swe-backend",
      "tags": ["auth", "security", "urgent"]
    },
    "actor": "swe-architect"
  }
}
```

---

## aof_task_cancel

Cancel a task (moves to `cancelled` — terminal state).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task ID or prefix |
| `reason` | string | — | Cancellation reason (logged) |
| `actor` | string | — | Calling agent ID |

**Example:**

```json
{
  "tool": "aof_task_cancel",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "reason": "Superseded by TASK-2026-02-21-010",
    "actor": "swe-architect"
  }
}
```

---

## aof_task_dep_add

Add a dependency to a task (task will be blocked until the blocker is done).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The dependent task |
| `blockerId` | string | yes | Task that must complete first |
| `actor` | string | — | Calling agent ID |

**Returns:**

```typescript
{
  taskId: string;
  blockerId: string;
  dependsOn: string[];   // Full updated dependsOn array
}
```

---

## aof_task_dep_remove

Remove a dependency from a task.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The dependent task |
| `blockerId` | string | yes | Dependency to remove |
| `actor` | string | — | Calling agent ID |

---

## aof_task_block

Block a task on an external dependency not tracked as another task.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task to block |
| `reason` | string | yes | What's blocking progress |
| `actor` | string | — | Calling agent ID |

**Example:**

```json
{
  "tool": "aof_task_block",
  "params": {
    "taskId": "TASK-2026-02-21-001",
    "reason": "Waiting for AWS credentials from platform team (ticket: INFRA-123)",
    "actor": "swe-backend"
  }
}
```

---

## aof_task_unblock

Mark a blocked task as ready for dispatch.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | Task to unblock |
| `actor` | string | — | Calling agent ID |

---

## aof_status

Get a status report of all tasks, optionally filtered by agent or status.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | — | Filter by agent ID |
| `status` | enum | — | Filter by task status |
| `compact` | boolean | — | Return compact summary (default: `false`) |
| `limit` | number | — | Max tasks to return |
| `actor` | string | — | Calling agent ID |

**Returns:**

```typescript
{
  total: number;
  byStatus: Record<TaskStatus, number>;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    agent?: string;
  }>;
}
```

**Example:**

```json
{
  "tool": "aof_status",
  "params": {
    "agent": "swe-backend",
    "status": "in-progress",
    "compact": false,
    "actor": "swe-backend"
  }
}
```

**Response:**

```json
{
  "total": 2,
  "byStatus": {
    "in-progress": 2
  },
  "tasks": [
    {
      "id": "TASK-2026-02-21-001",
      "title": "Implement JWT refresh token endpoint",
      "status": "in-progress",
      "agent": "swe-backend"
    },
    {
      "id": "TASK-2026-02-21-002",
      "title": "Add rate limiting middleware",
      "status": "in-progress",
      "agent": "swe-backend"
    }
  ]
}
```

---

## Tool Errors

All tools return structured errors when something goes wrong. Gate validation errors include teaching messages with the correct syntax:

```
Error: Task TASK-2026-02-21-001 is in a gate workflow (current gate: "code-review").

Gate tasks REQUIRE an 'outcome' parameter. Use:
  aofTaskComplete({
    taskId: "TASK-2026-02-21-001",
    outcome: "complete" | "needs_review" | "blocked",
    summary: "..."
  })

Current gate: code-review
```

This "progressive disclosure" pattern ensures agents learn the correct usage pattern from the error message itself.

## Task ID Prefix Resolution

All tools accept either a full task ID (`TASK-2026-02-21-001`) or a unique prefix (`TASK-2026-02-21`, `2026-02-21-001`). The tool searches for a unique match; if multiple tasks match the prefix, an error is returned.
