---
title: "AOF Known Issues & Workarounds"
description: "Current limitations and workarounds."
---

> Tracks known issues, workarounds, and resolution status. Update when an issue is resolved.
> See also: `DEPLOYMENT.md` for deployment-specific instructions.

---

## XRAY-001: `sessions_spawn` denied by default (Category B)
**Date**: 2026-02-16
**Symptoms**: Task dispatch fails with `"Agent not found: swe-architect"` (misleading error)
**Root cause**: `sessions_spawn` is in OpenClaw's `DEFAULT_GATEWAY_HTTP_TOOL_DENY` list. AOF dispatches tasks via HTTP `/tools/invoke`, which is blocked by default.
**Fix**: Add `sessions_spawn` to `gateway.tools.allow` in `openclaw.json`:
```json
{ "gateway": { "tools": { "allow": ["sessions_spawn"] } } }
```
**Prevention**: `DEPLOYMENT.md` Step 4 now includes this as a required config step.

---

## XRAY-002: AOF plugin config key is `config`, not `settings` (Category A)
**Date**: 2026-02-16
**Symptoms**: Plugin loads but `dryRun` stays `true` despite config. Scheduler polls but never dispatches.
**Root cause**: Plugin was reading `plugins.entries.aof.settings` but OpenClaw passes `plugins.entries.aof.config`.
**Fix**: Use `config` key in `openclaw.json`:
```json
{ "plugins": { "entries": { "aof": { "config": { "dryRun": false, "gatewayUrl": "...", "gatewayToken": "..." } } } } }
```
**Prevention**: Fixed in AOF plugin code + documented in `DEPLOYMENT.md`.

---

## XRAY-003: Memory-core config location (Category B)
**Date**: 2026-02-16
**Symptoms**: `memorySearch` shows "unavailable" in agent sessions.
**Root cause**: `memorySearch` config was at top level (legacy, auto-migrated but warns). Must be at `agents.defaults.memorySearch`.
**Fix**: Move to `agents.defaults.memorySearch` with proper provider config.
**Prevention**: Documented in `DEPLOYMENT.md`.

---

## XRAY-004: Stale lease prevents re-dispatch after block recovery (Category A)
**Date**: 2026-02-16
**Symptoms**: Task moved from `blocked` to `ready` but scheduler reports `no_executable_actions`. Task sits in ready indefinitely.
**Root cause**: Task file retained `lease:` block from previous dispatch. Scheduler sees active lease and won't re-dispatch even though status is `ready`.
**Status**: RESOLVED (2026-02-18) — `transitionTask()` in `task-mutations.ts` clears `lease` frontmatter field whenever `newStatus === "ready"` (also `done` and `backlog`). Regression test added in `task-store-block-unblock.test.ts`.

---

## XRAY-009/010: Agent dispatch fails with "Agent not found" (Category B — RESOLVED)
**Date**: 2026-02-16
**Symptoms**: `sessions_spawn` via HTTP `/tools/invoke` returns "Agent not found: swe-backend" despite agent existing in config.
**Root cause (XRAY-009)**: `gateway.tools.allow: ["sessions_spawn"]` was lost during config edits. Without it, `sessions_spawn` is blocked by `DEFAULT_GATEWAY_HTTP_TOOL_DENY`.
**Root cause (XRAY-010)**: `main` agent was missing `subagents.allowAgents: ["*"]`. Without this, `agents_list` returns `allowAny: false` and spawn is rejected even for agents that exist in config.
**Fix**: Both config keys must be set:
```yaml
gateway:
  tools:
    allow: ["sessions_spawn"]
agents:
  list:
    - id: main
      subagents:
        allowAgents: ["*"]
```
**Prevention**: Added to `DEPLOYMENT.md` as "Critical: Agent Spawn Permissions" section. Both keys are now mandatory deployment checklist items.

---

## XRAY-005: Agents don't call `aof_task_complete` (Category A/B — under investigation)
**Date**: 2026-02-16
**Symptoms**: Tasks dispatched successfully, agents do work (create files, sub-tasks), but never mark task complete. Lease expires → task re-queued → infinite loop. 46 dispatches, 0 completions observed.
**Root cause**: **Under investigation**. Hypotheses:
1. Plugin tools (`aof_task_complete`) not visible in sub-agent sessions (possibly due to `tools.sessions.visibility: tree` default in OpenClaw 2026.2.14)
2. Model (`qwen3-coder:30b`) doesn't reliably follow tool-calling instructions
3. No fallback completion mechanism exists
**Fix**: Pending root cause analysis (architect investigating).
**Prevention**: TBD.

---

## XRAY-006: Task retry count persists across manual recovery (Category A — RESOLVED)
**Date**: 2026-02-16
**Symptoms**: After manually moving task from `blocked` to `ready`, `metadata.retryCount` still reflects previous failures.
**Root cause**: Manual file move doesn't reset metadata fields.
**Status**: RESOLVED (2026-02-19) — `unblockTask()` and `resetDispatchFailures()` now clear `retryCount`. Use `aof task unblock <id>` instead of manual file moves.

---

## Murmur Orchestration Limitations (Informational)

### File-based state does not scale to distributed deployments
**Date**: 2026-02-17
**Component**: Murmur state manager
**Symptoms**: Murmur state is stored in `.murmur/<team-id>.json` files. Multiple scheduler instances (e.g., HA deployment) will have independent state views and may spawn duplicate review tasks.
**Root cause**: Murmur uses filesystem-based state persistence with in-process locks. No cross-process or cross-host synchronization.
**Fix**: For distributed deployments, use a single scheduler instance or implement a shared state backend (e.g., Redis, PostgreSQL).
**Prevention**: Murmur is designed for single-scheduler deployments. Multi-scheduler support requires architectural changes (shared state layer).

### Review timeout is wall-clock time, not CPU time
**Date**: 2026-02-17
**Component**: Murmur cleanup logic
**Symptoms**: If an orchestrator agent session is paused, suspended, or blocked on I/O, the review timeout (default 30 minutes) still elapses. Murmur will clear `currentReviewTaskId` and allow new reviews to fire even if the orchestrator eventually resumes.
**Root cause**: `reviewTimeoutMs` is measured from `reviewStartedAt` timestamp, not cumulative agent execution time.
**Fix**: Murmur's stale cleanup logic clears state but does **not** cancel the stale task. Manually transition stuck review tasks to `blocked` or `done`.
**Prevention**: Set `reviewTimeoutMs` high enough to accommodate normal orchestration work. Use agent heartbeat monitoring to detect stuck sessions early.

### Trigger evaluation is sequential, not parallel
**Date**: 2026-02-17
**Component**: Trigger evaluator
**Symptoms**: Murmur evaluates triggers in order; first match wins (short-circuit). If multiple triggers should fire simultaneously, only the first one listed in `murmur.triggers` will execute.
**Root cause**: By design. Prevents duplicate reviews from different triggers.
**Fix**: Order `murmur.triggers` by priority in `org-chart.yaml`.
**Prevention**: Intentional behavior. Not a bug.

---

## Vitest Serialization Lock (Informational)

### Why `scripts/test-lock.sh` exists
**Date**: 2026-02-17
**Component**: Test infrastructure
**Symptoms**: Multiple concurrent test runs (e.g., parallel agent worktrees running `npm test`) interfere with each other, causing flaky failures or file conflicts.
**Root cause**: Vitest by default runs test files in parallel (within a single `npm test` invocation). AOF tests create and modify files in shared directories (e.g., test fixtures, `.murmur/` state files). Concurrent test suites from multiple `npm test` processes can collide.
**Fix**: `scripts/test-lock.sh` wraps vitest with `flock` (kernel-level advisory lock). Only one test run executes at a time per lock file.
**Config**:
- `AOF_TEST_LOCK_DIR` — Lock directory (default: `/tmp`)
- `AOF_TEST_LOCK_TIMEOUT` — Max wait seconds (default: 300)
**Prevention**: Agents using git worktrees should set `AOF_TEST_LOCK_DIR` to worktree-specific paths to allow concurrent tests across worktrees. **TODO**: AOF-adf (dispatch throttling) will enforce this at the scheduler level.
