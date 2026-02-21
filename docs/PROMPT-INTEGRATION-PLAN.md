> **Internal document** — context-specific details may not apply to general deployments.

# AOF → OpenClaw Prompt & Workspace File Changes Plan
**Scope:** Prompt/MD updates only. Aligns with `docs/INTEGRATION-PLAN.md` phases. Keep additions minimal and preserve coexistence with `sessions_spawn` until full rollout.

## Phase Map (what changes when)
- **Phase B (plugin install, no tools):** No prompt changes required.
- **Phase C1 (tools enabled for swe-architect + swe-qa only):**
  - Minimal **AGENTS.md / SOUL.md / MEMORY.md** additions to *prefer AOF when tools exist*.
  - Add **per-agent AOF quickstart** for swe-architect + swe-qa only.
  - Cron prompts: add **conditional AOF usage** (fallback to current behavior when tools unavailable).
- **Phase C3 (tools enabled for all agents):**
  - Same rules apply globally; remove “fallback-first” phrasing where safe.
  - Optional: consolidate AOF guidance into a tiny shared file.

---

## 1) `AGENTS.md` (global directives)
**Goal:** Introduce AOF task workflow without breaking existing spawn flow.

### Change A: update “Delegate slow work” principle
**Before** (current):
```md
2. **Delegate slow work** — spawn sub-agents for tasks >10 seconds
```
**After** (Phase C1+):
```md
2. **Delegate slow work** — if AOF tools are available, create/dispatch a task via `aof_dispatch`; otherwise use `sessions_spawn`.
```

### Change B: augment Interaction Contract with task IDs + AOF updates
**Before**:
```md
| ACK | What + where outputs land |
| PLAN | 2–5 bullets |
| PROGRESS | At boundaries or every 2+ min |
| DONE | Artifacts + validation |
```
**After**:
```md
| ACK | What + where outputs land (include AOF taskId if present) |
| PLAN | 2–5 bullets |
| PROGRESS | At boundaries or every 2+ min (and `aof_task_update` if available) |
| DONE | Artifacts + validation (and `aof_task_complete` if available) |
```

### Change C: add a tiny AOF workflow stanza (keep short)
**Add** under “Interaction Contract” (Phase C1+):
```md
### AOF Task Workflow (phased)
- If AOF tools are available: dispatch via `aof_dispatch`, update via `aof_task_update`, complete via `aof_task_complete`.
- If AOF tools are not available: keep using `sessions_spawn` and leave the task card in `ready`.
```

---

## 2) `SOUL.md` (routing rules)
**Goal:** Route SWE work via AOF dispatch when tools are enabled, without breaking fallback.

### Change A: update SWE routing rule
**Before**:
```md
- If the user prefixes a message with `ARCH:` ... delegate to `swe-architect`...
  - If there's no prefix but it's clearly software work ... route to `swe-architect` by default.
```
**After** (Phase C1+):
```md
- If the user prefixes a message with `ARCH:` ... delegate to `swe-architect`...
  - If there's no prefix but it's clearly software work ... route to `swe-architect` by default.
  - When AOF tools are enabled: create/dispatch a task via `aof_dispatch` instead of ad‑hoc spawn. Fallback to `sessions_spawn` only if AOF tools aren’t available.
```

### Change B: add a boundary for bypassing AOF
**Add** under “Boundaries”:
```md
- Don’t bypass AOF task cards when AOF tools are available (exceptions: emergency/one‑off with explicit note).
```

---

## 3) `MEMORY.md` (durable facts + preferences)
**Goal:** Capture AOF infrastructure + the coexistence rule.

### Change A: add AOF tool availability + workflow preference
**Add** under “Preferences (stable defaults)” (Phase C1+):
```md
- **AOF task workflow (phased)**: When AOF tools are available, prefer `aof_dispatch` for delegation; update tasks with `aof_task_update`/`aof_task_complete`; use `aof_status_report`/`aof_board` for summaries. Fallback to `sessions_spawn` only when AOF tools are unavailable.
```

### Change B: extend sessions_spawn note to mention AOF
**Before**:
```md
- **sessions_spawn vs sessions_send**: ... Use `sessions_spawn` for task delegation; use `sessions_send` for ongoing conversations...
```
**After**:
```md
- **sessions_spawn vs sessions_send**: ... Use `sessions_spawn` for task delegation *only when AOF tools are unavailable*; otherwise use `aof_dispatch`. Use `sessions_send` for ongoing conversations...
```

### Change C: add AOF state + org chart paths
**Add** under “Infrastructure (stable config)” (Phase C1+):
```md
- **AOF state**: `~/.openclaw/aof/` (tasks/, events/, runs/, views/)
- **Org chart**: `~/.openclaw/aof/org-chart.yaml` (SSOT for roles/permissions)
```

### Change D: update cold-context directive to reflect AOF
**Before** (current excerpt):
```md
- **Cold context directive (FLEET-WIDE)**: ... AOF-idiomatic future: bundle context into task artifacts (inputs, links, docs) ...
```
**After** (Phase C3):
```md
- **Cold context directive (FLEET-WIDE)**: When AOF tools are available, use task card `inputs/`/`outputs/` as the default context carrier. Only provide long briefings in spawn messages if AOF tools are unavailable.
```

---

## 4) Per-agent workspace changes (minimal, phased)
**Goal:** Give early adopters (architect + QA) a tiny AOF quickstart without global prompt bloat.

### Phase C1 (architect + QA only)
**Add** `AOF.md` to:
- `~/.openclaw/agents/swe-architect/workspace/AOF.md`
- `~/.openclaw/agents/swe-qa/workspace/AOF.md`

**Suggested content (≤25 lines):**
```md
# AOF Quickstart (Phase C1)
- Prefer `aof_dispatch` for new tasks; avoid `sessions_spawn` unless AOF tools are missing.
- Update progress with `aof_task_update` (status/body).
- Mark completion with `aof_task_complete` (summary).
- Use `aof_status_report` or `aof_board` for quick status.
- Task context lives in task card + inputs/; write outputs to outputs/.
```

### Phase C3 (all SWE agents)
**Copy the same `AOF.md`** into each SWE agent workspace (or add a 3‑line note to their per‑agent `AGENTS.md` if you want to avoid extra files).

---

## 5) New files needed
**Recommendation:** *No new global file yet.* Keep AOF guidance in per‑agent files for early adopters.
- **Phase C1:** per‑agent `AOF.md` for swe-architect + swe-qa only (see above).
- **Phase C3 (optional):** add a **tiny** `~/.openclaw/workspace/AOF.md` (≤30 lines) and link to it from AGENTS/SOUL if you want a single shared reference.

---

## 6) Cron job prompt updates (task management only)
**These jobs explicitly manage AOF tasks and should be updated.**

### Job: `04a2bebb-7f6e-4222-86c2-af33998f191b` — “AOF progress check-in (20min)”
**Problem:** Uses filesystem scans + `sessions_list` and spawns via ad‑hoc rules.

**Before (excerpt):**
```md
3. Get full kanban board state:
   cd ~/Projects/AOF
   for d in backlog todo ready in-progress review done blocked; do ...
4. If the team is stalled ... spawn swe-architect to pick up the next task. Include FULL project context...
```

**After (Phase C1+ with fallback):**
```md
3. If AOF tools available: use `aof_board` or `aof_status_report` to summarize board.
   Otherwise, fallback to the filesystem scan.
4. If stalled and AOF tools available: call `aof_dispatch` with the next taskId.
   Otherwise, fallback to `sessions_spawn` with full context.
```

> **Note:** Since this cron runs under **main** (no AOF tools in C1), keep the fallback in place until Phase C3 *or* retarget the job to swe-architect in Phase C1.

### Jobs (disabled but should be updated before enabling)
- `1f927e05-2f9a-403d-b34b-60970a36162c` — “AOF overnight project monitor (15m)”
- `6b74bebe-9ef0-4518-b2e3-274333c4bbe2` — “AOF Overnight Monitor”
- `543d1e89-9d88-4a8d-a617-ce70c2f2fb43` — “AOF Overnight Monitor”

**Update pattern:** replace direct `find tasks/...` with `aof_status_report`/`aof_board` when tools are available; keep filesystem fallback until Phase C3.

---

## 7) What NOT to change yet (until AOF validated in production)
- **Do not remove** `sessions_spawn` guidance from AGENTS/MEMORY; keep as fallback during coexistence.
- **Do not require** AOF usage for agents that don’t yet have AOF tools (pre‑C3).
- **Do not add** long AOF runbooks to global prompt context (avoid bloat).
- **Do not update** scheduler/cron governance runbooks until AOF scheduler + hooks are live and stable.
- **Do not move** existing non‑AOF cron jobs or digests into AOF yet (avoid coupling).

---

## Summary Checklist (actionable)
- [ ] Apply AGENTS.md, SOUL.md, MEMORY.md snippets (Phase C1).
- [ ] Add per‑agent `AOF.md` to swe-architect + swe-qa workspaces (Phase C1).
- [ ] Patch cron job `04a2bebb...` with AOF conditional logic (Phase C1).
- [ ] Update disabled AOF monitor cron prompts before re‑enabling (Phase C3).
- [ ] Optionally add a tiny global `AOF.md` after C3 if needed.
