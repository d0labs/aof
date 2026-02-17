# AOF Task Completion Loop — Analysis (2026-02-16)

## Executive Summary
The completion loop is primarily caused by **AOF tools being registered as _optional_ plugin tools**, which are **filtered out unless the session’s tool allowlist explicitly includes the plugin or `group:plugins`**. Sub-agent sessions spawned via `sessions_spawn` appear to **not** include such allowlist entries by default, so `aof_task_complete` (and related tools) are **not visible to the spawned agent**. As a result, agents cannot call the tool even when instructions say to do so, and leases eventually expire, returning tasks to `ready`.

## Evidence & Findings

### 1) AOF tools are registered as optional plugin tools
Source: `~/Projects/AOF/dist/openclaw/adapter.js`
```js
api.registerTool({ name: "aof_task_complete", ... }, { optional: true });
api.registerTool({ name: "aof_task_update", ... }, { optional: true });
api.registerTool({ name: "aof_status_report", ... }, { optional: true });
```

### 2) Optional plugin tools require explicit allowlist
OpenClaw (global install) resolves plugin tools with an allowlist gate. If allowlist is empty, **optional tools are excluded**.

Source: `/opt/homebrew/lib/node_modules/openclaw/dist/pi-embedded-CNutRYOy.js`
```js
function isOptionalToolAllowed(params) {
  if (params.allowlist.size === 0) return false;
  ...
  return params.allowlist.has("group:plugins");
}
```
`resolvePluginTools(...)` filters optional tools through this allowlist.

### 3) Sub-agent sessions likely do not include plugin allowlist
`pluginToolAllowlist` is derived from tool policy allowlists (profile/global/agent/group/subagent). If none are configured, allowlist is empty and optional tools are removed.

### 4) Mule session evidence
Recent Mule session logs show **no tool availability list** and **no `aof_task_complete` calls**. The session log confirms the task instructions told the agent to call `aof_task_complete`, but completion never happened. (Example: `/home/node/.openclaw/agents/swe-architect/sessions/fbd06b4b-...jsonl`).

### 5) Model compliance is secondary
The initial model on Mule was `qwen3-coder:30b`, but the session later switched to `gpt-5.2-codex`. Both still lacked tool completion, suggesting **tool unavailability** is the primary blocker, not model compliance.

---

## Root Cause Determination
**Primary root cause:** AOF plugin tools are optional and therefore filtered out in sub-agent sessions without explicit allowlists. This prevents agents from calling `aof_task_complete`.

**Secondary contributing factors:**
- The dispatch instruction only mentions `aof_task_complete` but provides **no filesystem fallback**.
- No completion detector exists when sessions end.
- Lease TTL renewal exists in code but has **no runtime heartbeat mechanism**.

---

## Fix Options (Recommended Order)

### Option A — Make AOF tools non-optional (fastest & robust)
Change `registerTool(..., { optional: true })` → **remove optional** in `src/openclaw/adapter.ts` (and rebuild dist). This will expose the tools in all sessions without allowlist configuration.

**Pros:** Immediate availability for all sessions. No config changes needed.
**Cons:** Security exposure if you intended plugin tools to be gated.

### Option B — Allow plugin tools for sub-agent sessions
Update OpenClaw tool policy to include `group:plugins` (or `aof`) in allowlists for the relevant agents or subagent policy. This keeps optional gating but ensures visibility.

**Pros:** Keeps explicit policy control.
**Cons:** Requires config updates on Mule; easy to miss in future environments.

### Option C — Add filesystem fallback in task instruction
If tools are not available, instruct the agent to:
- Move the task file from `tasks/in-progress/` → `tasks/done/`, or
- Update the frontmatter status to `done` and append completion summary.

**Pros:** Works even without tools.
**Cons:** Bypasses AOF service logic/events unless you match format perfectly.

### Option D — Completion detector on agent_end
Hook into `agent_end` to detect completed tasks (e.g., task file updated or outputs present) and call `aof_task_complete` or move the file. This is a safety net if the agent never calls completion.

**Pros:** Prevents infinite loops.
**Cons:** Heuristic-heavy; may mis-classify tasks.

---

## Lease Renewal Status
AOF **supports lease renewal in the store API** (`renewLease` exists), but **no runtime heartbeat mechanism** currently calls it. Searches in `src/` show `renewLease` used only in tests. Therefore, **lease renewal is not active** in production, and long tasks can time out regardless of progress.

**Recommendation:** Add a heartbeat/renew loop during task execution or periodic scheduler renewal while the session is active.

---

## Proposed Next Steps
1. **Implement Option A or B** (prefer A if security risk is acceptable).
2. Add **fallback completion** text to `formatTaskInstruction` in `openclaw-executor`.
3. Add **completion detector** on `agent_end` if you want a safety net.
4. Add a **lease renewal heartbeat** or a scheduler-level renewal while an agent session is active.

---

## Appendix — Key Code References
- `~/Projects/AOF/dist/openclaw/adapter.js` — tool registration (optional)
- `/opt/homebrew/lib/node_modules/openclaw/dist/pi-embedded-CNutRYOy.js` — allowlist filtering for optional plugin tools
- `~/Projects/AOF/src/store/lease.ts` — `renewLease` exists but unused in runtime
