# AOF Known Issues & Workarounds

> Referenced by all SWE agents. Update this whenever a Project Xray issue is resolved.
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
**Fix**: Clear the `lease:` block from task frontmatter when moving out of `blocked` state.
**Prevention**: AOF scheduler should strip lease metadata on status transitions to `ready`. **TODO**: Fix in AOF code — `handleBlockedTask()` should clear lease on recovery.

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

## XRAY-006: Task retry count persists across manual recovery (Category A)
**Date**: 2026-02-16
**Symptoms**: After manually moving task from `blocked` to `ready`, `metadata.retryCount` still reflects previous failures.
**Root cause**: Manual file move doesn't reset metadata fields.
**Fix**: Manually reset `retryCount: 0` when recovering tasks.
**Prevention**: AOF should provide a CLI command or tool for task recovery that handles metadata cleanup. **TODO**: Add `aof task recover <id>` command.
