---
title: "Agent Instructions for AOF Contributors"
description: "Task workflow for agents contributing to AOF."
---

This document describes the task workflow and session discipline expected of agents working on the AOF codebase.

AOF uses its **own task management system** (`aof task`) for tracking work. There is no external task tracker.

---

## Finding Work

```bash
# Show all tasks by status (Kanban-style)
aof scan

# Show tasks ready for pickup (no open blockers)
aof scan --status ready

# Show Kanban board
aof board
```

## Claiming and Working a Task

```bash
# View task details
aof scan                          # find the task ID
cat tasks/ready/TASK-<id>.md     # read the task card

# The scheduler dispatches tasks to agents automatically.
# If working manually, promote a backlog task to ready:
aof task promote TASK-<id>

# Update status as you work (use aof_task_update tool in OpenClaw)
aof_task_update TASK-<id> --status in-progress

# Block a task if you're stuck
aof task block TASK-<id> "Waiting on API spec from swe-architect"

# Unblock when resolved
aof task unblock TASK-<id>
```

## Completing Work

```bash
# Mark a task complete
aof task close TASK-<id>

# Or via OpenClaw tool (preferred when running as an agent)
aof_task_complete TASK-<id> --outcome complete
```

## Creating Tasks

```bash
# Create a new task
aof task create "Implement rate limiting" --priority high --agent swe-backend

# Create with team assignment
aof task create "Review security policy" --team swe-security

# Add a dependency (task waits on blocker)
aof task dep add TASK-child TASK-blocker
```

## Landing the Plane (Session Completion)

**When ending a work session**, complete ALL steps before stopping. Work is not done until it's pushed.

1. **Create follow-up tasks** for any remaining work — use `aof task create`
2. **Run quality gates** (if code changed): tests, linters, build
3. **Update task status** — close finished tasks, update in-progress ones
4. **Push to remote** — this is mandatory:
   ```bash
   git pull --rebase
   git push
   git status  # must show "up to date with origin"
   ```
5. **Verify** — all changes committed and pushed
6. **Hand off** — leave context for next agent in task card outputs/

**Critical rules:**
- Work is NOT complete until `git push` succeeds
- Never stop before pushing — that leaves work stranded locally
- If push fails, resolve and retry until it succeeds

---

## Task File Format

Task cards are plain Markdown files with YAML frontmatter in `tasks/<status>/`:

```markdown
---
schemaVersion: 1
id: TASK-2026-02-21-001
title: Add rate limiting to API gateway
status: ready
priority: high
assignee: swe-backend
team: swe-suite
tags: [api, security]
createdAt: "2026-02-21T00:00:00Z"
---

## Instructions

Implement token-bucket rate limiting on all public API routes.

## Acceptance Criteria

- [ ] Rate limit enforced at 100 req/min per IP
- [ ] Returns 429 with Retry-After header
- [ ] Unit tests pass (>90% coverage)
- [ ] No regression in existing API tests
```

See [Task Format](../guide/task-format.md) for the full frontmatter schema.
