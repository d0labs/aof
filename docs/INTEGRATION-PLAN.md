> **Internal document** — context-specific details may not apply to general deployments.

# AOF → OpenClaw Production Integration Plan

**Scope:** Deploy AOF as an OpenClaw plugin in the existing production instance. This is a plan/runbook only. No implementation changes beyond deployment steps.

**IMPORTANT:** Before executing this plan, all items in `docs/DEFINITION-OF-DONE.md` must be satisfied. See `docs/PLUGIN-INTEGRATION-STATUS.md` for current status. 

**Environment Summary**
- OpenClaw 2026.2.6 on target host (macOS arm64)
- 18 agents (main + suite)
- Config managed via `gateway(action="config.patch")` only (never edit on disk)
- Plugin load via `plugins.entries[]` in `openclaw.json`
- Observability: Prometheus :9100, Loki shipper, Grafana
- Existing plugins: `serena-lsp`, `metrics-bridge`

**AOF**
- Codebase: `~/Projects/AOF/`
- Build: `npm run build` → `dist/`
- OpenClaw adapter: `src/openclaw/adapter.ts`
- State location: `~/.openclaw/aof/`

---

## 0) Pre-Deployment Checklist (Gate: GO/NO-GO)
**Must be true before any change:**
1. **Change window approved** (maintenance window + stakeholder notice). Aim for lowest-traffic window.
2. **Baseline snapshots captured**:
   - OpenClaw config snapshot (from `gateway(action="config.get")` or latest config export).
   - `~/.openclaw/` directory backup (excluding large caches if needed).
   - Current plugin list and tool allow-list snapshot.
3. **Build is green**:
   - `npm ci` + `npm test` (all 827 tests pass) in `~/Projects/AOF`.
   - `npm run build` completes and `dist/` is fresh.
4. **Risk controls ready**:
   - Rollback plan validated (see §8). 
   - Owner/On-call for this change assigned.
5. **Compatibility checks**:
   - Node >=22 available on host.
   - OpenClaw plugin API compatibility validated against current docs.
6. **QA gate (pre-deploy)**:
   - Plugin loads cleanly in the test harness (no gateway crash).
   - All AOF tools are registered with expected names.
   - Service start/stop verified in harness.
   - QA sign-off recorded before any gateway restart.
7. **Scheduling conflict review**:
   - Identify cron jobs touching task scheduling or orchestration. Confirm no direct conflict or plan temporary pause.
7. **Agent inventory**:
   - Confirm the 18 agent IDs (for org chart mapping) are correct and stable.
8. **Observability readiness**:
   - Prometheus/Loki/Grafana access confirmed.
   - Metrics/labels naming collisions reviewed.

**GO/NO-GO Criteria:**
- GO if all pre-checks pass and on-call available for entire window.
- NO-GO if any tests fail, config snapshots missing, or maintenance window unavailable.

---

## 1) Build & Package (Prepare AOF Artifact)
**Goal:** produce a clean, reproducible plugin artifact.

**Steps**
1. From `~/Projects/AOF/`:
   - `npm ci`
   - `npm test`
   - `npm run build`
2. Verify:
   - `dist/` exists and contains OpenClaw adapter output.
   - `package.json` version is pinned for this deployment.
3. Create deployment bundle:
   - Package `dist/`, `package.json`, and any required runtime files into a deployment directory (e.g., `~/Projects/AOF/dist/openclaw-plugin/`).

**Verification (Gate):**
- Tests green, build success, artifact contains adapter + runtime deps.

**Rollback:**
- None needed (no production impact yet).

---

## 2) AOF State Initialization (Staged, Pre-Activation)
**Goal:** create initial state layout without turning on scheduling.

**Steps**
1. Create base directory:
   - `~/.openclaw/aof/` with subdirs: `tasks/`, `events/`, `runs/`, `views/`.
2. Create org chart at `~/.openclaw/aof/org-chart.yaml` mapping the 18 agents.
3. Establish mock-vault pointers/symlinks for visibility **without** moving tasks into vault.

**Verification (Gate):**
- Directory tree exists with correct permissions.
- Org chart passes lint/validation (if AOF provides validator).

**Rollback:**
- Remove `~/.openclaw/aof/` (if empty or new) **only if no AOF runs have occurred**.
- If runs/events exist, archive the entire directory before deletion.

---

## 3) Plugin Installation (No Activation Yet)
**Goal:** install plugin code and register it, but delay tool enablement.

**Steps**
1. Copy plugin bundle to:
   - `~/.openclaw/extensions/aof/` (or official path per OpenClaw plugin guidelines).
2. Prepare a **single** `gateway(action="config.patch")` that:
   - Adds plugin entry to `plugins.entries[]`.
   - Does **not** enable tools for any agent yet.
3. **Schedule restart** (full process restart required; SIGUSR1 does not reload TS).
   - Drain/complete active sessions if possible.
   - Restart LaunchAgent service cleanly.

**Verification (Gate):**
- Gateway starts cleanly, logs show AOF plugin loaded.
- No tool exposure yet; check tool list matches baseline + plugin registration only.

**Rollback:**
- If startup fails: revert config via `config.patch` to prior snapshot and restart.
- Remove `~/.openclaw/extensions/aof/` only after config rollback.

---

## 4) Tool Enablement Strategy (Phased Rollout)
**Goal:** minimize blast radius and context bloat.

**Approach:** phased rollout to 2–3 low-risk agents first (e.g., `swe-architect`, `swe-qa`, `swe-devops`), then expand to all 18 after validation.

**Steps**
1. Phase 1: enable AOF tools for selected agents via **single** `config.patch` update to `tools.allow[]`.
2. Observe for 24–48 hours (or agreed interval).
3. Phase 2: enable for remaining agents in one additional patch.

**Verification (Gate):**
- Selected agents can invoke AOF tools; others cannot.
- No unexpected tool collisions or naming conflicts.

**Rollback:**
- Remove AOF tool entries from `tools.allow[]` via `config.patch`.
- No restart required for tool allow list changes (confirm with OpenClaw docs).

---

## 5) Scheduling & Event Hooks Activation
**Goal:** enable scheduler and event-driven hooks without conflicting with cron.

**Steps**
1. Confirm cron jobs that might overlap scheduling are paused or scoped.
2. Enable AOF scheduler polling interval (configurable); start with conservative interval.
3. Enable event hooks: `session_end`, `agent_end`, `message_received`, `before_compaction`.
4. Verify dispatcher uses `sessions_spawn` correctly.

**Verification (Gate):**
- AOF runs are recorded in `~/.openclaw/aof/runs/`.
- No spike in scheduler activity or unexpected task duplication.

**Rollback:**
- Disable scheduler + hooks via AOF config (or tool toggles) and restart plugin if required.
- Restore cron orchestration if paused.

---

## 6) Observability Integration
**Goal:** ensure AOF metrics/logging are visible in existing stack.

**Steps**
1. Metrics:
   - Confirm AOF exposes Prometheus metrics on existing exporter path/labels.
   - Add/adjust Grafana dashboard panels as needed.
2. Logs:
   - Ensure plugin logs are tagged for Loki ingestion.
3. Alerts:
   - Add alerts for scheduler errors, task failure rate, and plugin load failures.

**Verification (Gate):**
- Metrics appear within 5–10 minutes in Prometheus/Grafana.
- Logs visible in Loki with correct labels.

**Rollback:**
- Remove new dashboards/alerts (no impact to core system).

---

## 7) Post-Deployment Validation (Comprehensive)
**Health checks (complete after Phase 2):**
1. OpenClaw gateway stable for 24h (no crash loops).
2. AOF scheduled tasks execute correctly; no conflict with cron jobs.
3. Event hooks fire on all four event types; verify by controlled triggers.
4. All agents can access tools as expected; no unexpected context bloat or tool collisions.
5. AOF state integrity: no corruption in `tasks/`, `events/`, `runs/`.
6. Observability OK: metrics/logs stable, dashboards updated.

**Gate:**
- Success if all checks pass for 24h; otherwise hold and rollback if severe.

---

## 8) Rollback Plan (Per Phase)
**General Rules**
- Always rollback via `gateway(action="config.patch")` using the pre-deployment snapshot.
- Never edit on-disk config directly.
- Preserve AOF state for forensic review unless explicitly approved to delete.

**Phase 1–2 (Build/State Init)**
- Remove `~/.openclaw/aof/` only if no runs/events created.
- Otherwise, archive to `~/.openclaw/aof-rollback-<timestamp>/`.

**Phase 3 (Plugin Install + Restart)**
- Revert `plugins.entries[]` to pre-change snapshot.
- Restart OpenClaw (LaunchAgent).
- Remove `~/.openclaw/extensions/aof/` after gateway confirms no AOF load.

**Phase 4 (Tool Enablement)**
- Remove AOF tools from `tools.allow[]` and reapply patch.

**Phase 5 (Scheduler + Hooks)**
- Disable scheduler + hooks in AOF config (or tool toggle) and restart if required.
- Resume cron orchestration if paused.

**Post-Rollback Validation**
- Confirm plugin not loaded, tools removed, no AOF scheduling.
- Verify gateway stable and existing plugins unaffected.

---

## 9) Risk Assessment & Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Gateway restart disrupts active sessions | High | Schedule maintenance window; drain sessions; single restart only. |
| Scheduler conflicts with cron orchestration | Medium/High | Audit cron jobs; pause conflicting ones; start with conservative polling interval. |
| Org chart drift as agents change | Medium | Add monthly audit; validate org chart against current agent list. |
| Tool name collisions | Medium | Pre-flight tool name scan; namespace AOF tools (e.g., `aof_*`). |
| Context window bloat | Medium | Phased tool rollout; monitor token usage; only enable tools for necessary agents initially. |
| Plugin crash destabilizes gateway | High | Verify plugin isolation behavior; test in staging; roll back plugin entry fast. |
| Rollback complexity after state writes | Medium | Preserve state; document reversible steps; archive before delete. |

---

## 10) Sequencing & Gates (Execution Order)
**Phase A — Preparation (Parallel)**
- A1: Build + test + package AOF
- A2: Pre-deploy checklist + config snapshots
- A3: Observability prep (dashboards/alerts staged)

**Gate A:** all checks green; on-call engaged.

**Phase B — Install (Serial)**
- B1: Create AOF state structure (no scheduler)
- B2: Copy plugin to extensions dir
- B3: Apply config patch for `plugins.entries[]`
- B4: Restart OpenClaw (single restart)

**Gate B:** plugin loads cleanly; no tool exposure.

**Phase C — Tool Enablement (Phased)**
- C1: Enable tools for 2–3 agents
- C2: Validate for 24–48h
- C3: Enable tools for remaining agents

**Gate C:** no collisions; tools work as expected.

**Phase D — Scheduler + Hooks**
- D1: Enable scheduler (conservative interval)
- D2: Enable event hooks
- D3: Validate scheduling vs cron

**Gate D:** stable for 24h; no errors in logs or metrics.

**Phase E — Post-Deploy Validation**
- Full health checks; finalize rollout.

---

## 11) Verification Checklist (Quick Smoke Tests)
- [ ] OpenClaw gateway starts cleanly after restart
- [ ] AOF plugin shows as loaded in logs
- [ ] AOF tools visible only to allowed agents (phase 1)
- [ ] AOF can create a test task and record a run
- [ ] Event hook fires on `session_end` and `message_received`
- [ ] Metrics visible in Prometheus/Grafana
- [ ] No regression in existing plugins (serena-lsp, metrics-bridge)

---

## Notes / Constraints
- Config patches must be minimized (each dump is large). Aim for **two patches** max: one for plugin entry, one (or two) for tool enablement phases.
- No direct edits to `openclaw.json` on disk.
- SIGUSR1 is insufficient—requires full process restart to load plugin TS.

---

**End of Plan**
