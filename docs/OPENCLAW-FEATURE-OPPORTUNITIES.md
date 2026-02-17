# OpenClaw 2026.2.13–2026.2.15 — AOF Plugin Feature Opportunities

## Summary
Recent releases add plugin hooks for LLM I/O observation, nested sub‑agents, and safer config patching. Several subagent and gateway fixes improve announce reliability and session handling. These are relevant to AOF’s dispatch/monitoring model and the current “sub‑agent not calling `aof_task_complete`” issue. Below are the most actionable items with priority and estimated effort.

---

## 1) Plugin hooks: `llm_input` / `llm_output` payload exposure (2026.2.15)
**What:** Plugins can now observe prompt/input context and model output usage details via new hook payloads.

**How AOF could use it:**
- Capture per‑task prompt composition, tool call context, and output metadata (token counts, finish reason, etc.).
- Implement automatic quality heuristics (e.g., truncation/overflow, excessive retries, ungrounded output patterns).
- Add richer audit trails for task scoring and diagnosing failures.

**Priority:** **High** (direct quality/observability benefits).

**Code changes:**
- Implement `llm_input` and `llm_output` hook handlers in AOF plugin.
- Persist selected fields to task telemetry (per-run + per-subagent).
- Add guardrails to avoid storing sensitive content.

**Estimate:** **M (2–4 days)** — requires schema decisions + storage + privacy filtering.

---

## 2) Nested sub‑agents (`agents.defaults.subagents.maxSpawnDepth`) (2026.2.15)
**What:** Sub‑agents can spawn their own children when `maxSpawnDepth` is set (default 1, new example: `2`). Includes max child limit and depth-aware tool policy.

**How AOF could use it:**
- Allow AOF‑dispatched agents to delegate (e.g., research agent spawns QA agent).
- Reduce central orchestration load and shorten task cycles by enabling local fan‑out.

**Priority:** **High** (architectural unlock for distributed tasking).

**Code changes:**
- Update AOF config templates to set `agents.defaults.subagents.maxSpawnDepth` (likely `2`).
- Ensure `aof_task_complete` tool visibility propagates to sub‑sub‑agents (validate tool policy inheritance).
- Add max‑children safeguards aligned with AOF’s queueing limits.

**Estimate:** **M/H (3–6 days)** — config + validation + test coverage for nested lifecycle events.

**Note re: current issue:** Depth‑aware tool policy is new; verify whether this is affecting tool visibility in sub‑agent sessions. The symptoms (sub‑agents not calling `aof_task_complete`) could be caused by tool policy scoping. A targeted test should confirm if AOF tools are registered for sub‑agents at depth>1 or only in parent sessions.

---

## 3) `config.patch` merges object arrays by `id` (2026.2.14)
**What:** `config.patch` now merges object arrays (e.g., `agents.list`) by `id` instead of replacing the whole array.

**How AOF could use it:**
- Safe incremental edits of `agents.list` and other object arrays without deleting unrelated agents.
- Mitigates prior incident of 17 agents being dropped by partial patch.

**Priority:** **High** (prevents destructive config edits).

**Code changes:**
- Ensure AOF patch payloads always include stable `id` fields.
- Add sanity check in AOF config patcher: reject patches that omit `id` on array elements.

**Estimate:** **S (0.5–1 day)** — config validation + tests.

---

## 4) Subagent announce reliability (2026.2.15 + 2026.2.14)
**What:**
- 2026.2.15: deterministic announce idempotency keys for subagent delivery.
- 2026.2.14: preserve queued announce items on errors and retry delivery instead of dropping.

**How AOF could use it:**
- Reduce duplicate or missing AOF progress announcements when sub‑agents produce rapid updates or gateway experiences transient errors.

**Priority:** **Medium** (reliability improvement).

**Code changes:**
- No direct code changes required; monitor post‑upgrade behavior.
- Consider removing any local AOF de‑dup workarounds if they exist.

**Estimate:** **S (0–1 day)** — verify and simplify.

---

## 5) Security default: high‑risk tools blocked from `/tools/invoke` (2026.2.13)
**What:** `sessions_spawn`, `sessions_send`, `gateway` are blocked from HTTP `/tools/invoke` by default; requires `gateway.tools.{allow,deny}` override.

**How AOF could use it / risk:**
- If AOF dispatch relies on `/tools/invoke`, it must ensure explicit allowlisting in gateway config.
- This is likely the root of past dispatch failures in some environments.

**Priority:** **High** (dispatch reliability).

**Code changes:**
- Verify AOF deployment configs explicitly allow `sessions_spawn`/`sessions_send`.
- Add startup warning in AOF if tool permissions are insufficient.

**Estimate:** **S/M (1–2 days)** — config checks + diagnostics.

---

## 6) Session tool visibility scoping (2026.2.14)
**What:** `tools.sessions.visibility` default is now `tree` (restricts tool targeting to current session tree) with sandbox clamping.

**How AOF could use it / risk:**
- Improves isolation but can prevent cross‑session tool calls if AOF expects to target sibling sessions.
- Might explain missing `aof_task_complete` if sub‑agents are not within the expected session tree or tool registrations are scoped to parent only.

**Priority:** **Medium** (potentially linked to current bug).

**Code changes:**
- Audit AOF tool registration scope for sub‑agents.
- If needed, set explicit visibility or adjust tool routing to remain within the session tree.

**Estimate:** **M (2–3 days)** — debugging + config changes + tests.

---

## 7) Cron output delivery behavior (2026.2.14)
**What:** Cron now delivers text‑only output directly when `delivery.to` is set.

**How AOF could use it:**
- Ensure cron‑driven AOF jobs (if any) deliver full output instead of summaries.

**Priority:** **Low/Medium** (only relevant if AOF uses cron jobs).

**Code changes:**
- None if not using cron. If used, re‑evaluate message formatting assumptions.

**Estimate:** **S (0–1 day)**.

---

## 8) Optional tool error suppression (2026.2.14)
**What:** `messages.suppressToolErrors` can hide non‑mutating tool failure warnings from user chat.

**How AOF could use it:**
- Reduce user‑visible noise for background tool failures during agent runs.

**Priority:** **Low** (nice‑to‑have).

**Code changes:**
- Config toggle only.

**Estimate:** **XS (0.5 day)**.

---

## 9) Outbound write‑ahead delivery queue (2026.2.13)
**What:** Prevents lost outbound messages after gateway restarts; retries after crash.

**How AOF could use it:**
- More reliable AOF status announcements across Mule restarts / SIGUSR1.

**Priority:** **Medium** (reliability).

**Code changes:**
- No direct code changes; ensure AOF doesn’t implement redundant queueing.

**Estimate:** **XS (0–0.5 day)**.

---

# Recommendations (Next Steps)
1. **Implement `llm_input`/`llm_output` hooks** for task quality telemetry (High).
2. **Enable nested sub‑agents (maxSpawnDepth=2)** and validate tool visibility for `aof_task_complete` (High).
3. **Patch config safely with `id` merges**; add AOF config validation for `id` presence (High).
4. **Audit tool visibility and session tree scoping** to resolve missing `aof_task_complete` calls (Medium).

---

# Open Questions
- Do AOF sub‑agents run in a separate session tree or inherit the parent tree? This affects tool visibility under `tools.sessions.visibility=tree`.
- Are AOF tools registered per agent or globally? Depth‑aware tool policy might require explicit re‑registration for sub‑agents.

