# AOF Platform Leverage Roadmap
**Created:** 2026-02-16  
**Status:** Active  
**Context:** OpenClaw 2026.2.13–2026.2.15 releases

## Executive Summary

Recent OpenClaw releases provide critical capabilities for AOF's distributed agent coordination model. This document prioritizes platform feature adoption based on AOF's vision of deterministic, observable, restart-safe agent orchestration.

**Key insight:** The current blocker (sub-agents not calling `aof_task_complete`) is likely caused by session tool visibility scoping introduced in 2026.2.14. We must fix this before enabling nested sub-agents.

---

## Strategic Alignment with AOF Vision

AOF's core thesis: **bridge deterministic and semantic workloads** — give LLM agents structure to behave reliably without losing their utility.

These platform changes directly support that thesis:

| Feature | Vision Alignment | Impact |
|---------|-----------------|--------|
| **LLM I/O hooks** | Observable-by-default principle | Quality telemetry for semantic→deterministic feedback loop |
| **Nested sub-agents** | Distributed coordination without central bottleneck | Architectural unlock for local fan-out |
| **Session tool visibility** | Deterministic tool routing | CRITICAL: likely root cause of current blocker |
| **Config safety (id merges)** | Restart-safe, reliable operations | Prevents destructive config edits |
| **Announce reliability** | Restart-safe, observable | Crash-recovery for status updates |

---

## Prioritized Adoption Plan

### Phase 1: Fix Foundation (Sprint 2 — IMMEDIATE)
**Goal:** Resolve current blocker and prevent operational incidents.

#### 1.1 Diagnose and Fix Tool Visibility Bug 🔴 BLOCKER
**Priority:** P0  
**Effort:** M (2–3 days)  
**Owner:** swe-backend + swe-architect

**Problem:** Sub-agents are not calling `aof_task_complete`. OpenClaw 2026.2.14 changed `tools.sessions.visibility` default to `tree`, which restricts tool targeting to current session tree.

**Hypothesis:** AOF tools are registered in parent session scope but not visible to sub-agent sessions, OR sub-agents are outside the expected session tree.

**Action items:**
1. Audit AOF tool registration scope for sub-agents
2. Verify session tree structure when AOF dispatches agents
3. Test whether AOF tools are visible at depth > 1
4. Fix registration scope or adjust `tools.sessions.visibility` config as needed
5. Add integration test: sub-agent successfully calls `aof_task_complete`

**Success criteria:**
- Sub-agents can reliably call `aof_task_complete` in all dispatch scenarios
- Tool visibility behavior is deterministic and documented

**Dependencies:** None (blocking everything else)

---

#### 1.2 Safe Config Patching with ID Merges ✅ QUICK WIN
**Priority:** P0  
**Effort:** S (0.5–1 day)  
**Owner:** swe-backend

**Problem:** Prior to 2026.2.14, `config.patch` replaced entire arrays. We lost 17 agents in one incident.

**Action items:**
1. Ensure all AOF config patches include stable `id` fields on array elements
2. Add validation: reject patches that omit `id` on `agents.list` items
3. Add unit tests for safe incremental config edits
4. Document config patch format in AOF config guide

**Success criteria:**
- AOF config patches never delete unintended agents/config items
- Validation catches malformed patches before they reach OpenClaw

**Dependencies:** None

---

#### 1.3 Verify Gateway Tool Permissions 🔧 RELIABILITY
**Priority:** P0  
**Effort:** S/M (1–2 days)  
**Owner:** swe-devops + swe-backend

**Problem:** OpenClaw 2026.2.13 blocks `sessions_spawn`/`sessions_send` from `/tools/invoke` by default. If AOF dispatch relies on HTTP invocation, it may fail silently.

**Action items:**
1. Audit AOF dispatch code paths — do we use `/tools/invoke`?
2. Verify Mule gateway config explicitly allows `sessions_spawn`, `sessions_send`
3. Add AOF startup check: warn if required tools are not allowed in gateway config
4. Document required gateway config in deployment docs

**Success criteria:**
- AOF dispatch works reliably across all environments
- Deployment docs include gateway tool allowlist requirements

**Dependencies:** None

---

### Phase 2: Unlock Architecture (Post-Sprint 2)
**Goal:** Enable nested coordination and deep observability.

#### 2.1 Enable Nested Sub-Agents (maxSpawnDepth=2) 🚀 ARCHITECTURAL UNLOCK
**Priority:** P1  
**Effort:** M/H (3–6 days)  
**Owner:** swe-architect + swe-backend

**Value:** Allows AOF-dispatched agents to delegate locally (e.g., research agent spawns QA agent). Reduces central orchestration load, shortens task cycles.

**Action items:**
1. Set `agents.defaults.subagents.maxSpawnDepth: 2` in AOF config templates
2. Validate `aof_task_complete` tool visibility propagates to sub-sub-agents (depth=2)
3. Add max-children safeguards aligned with AOF's queueing limits
4. Update AOF scheduler logic to track nested task hierarchies
5. Add integration tests:
   - Parent dispatches agent → agent spawns sub-agent → both complete successfully
   - Max depth enforcement
   - Tool visibility at all depths

**Success criteria:**
- AOF agents can spawn their own sub-agents up to depth 2
- All AOF tools are visible and functional at all depths
- Scheduler correctly tracks and reports nested task trees

**Dependencies:**
- ✅ Phase 1.1 (tool visibility fix) MUST be complete first
- Configuration change only; no breaking changes to existing agents

**Risk mitigation:**
- Start with depth=2 (not higher) to limit complexity
- Monitor resource usage under nested dispatch
- Add circuit breaker if nested spawn rate exceeds threshold

---

#### 2.2 Implement LLM I/O Observability Hooks 📊 QUALITY TELEMETRY
**Priority:** P1  
**Effort:** M (2–4 days)  
**Owner:** swe-backend + swe-data-eng

**Value:** Capture per-task prompt composition, tool call context, and output metadata (token counts, finish reason, truncation). Enables automatic quality heuristics and richer audit trails.

**Strategic fit:** Directly supports AOF's "observable by default" principle. Provides semantic→deterministic feedback loop: track when agents produce low-quality outputs and feed that data back into task scoring.

**Action items:**
1. Implement `llm_input` and `llm_output` hook handlers in AOF plugin
2. Design telemetry schema:
   - Per-run: aggregate token usage, tool call counts, finish reasons
   - Per-subagent: drill-down for nested agent analysis
   - Privacy: filter sensitive content, store only metadata by default
3. Persist selected fields to task telemetry storage
4. Add Prometheus metrics: token usage, truncation rate, tool call frequency
5. Add quality heuristics (future):
   - Flag tasks with excessive retries
   - Flag tasks with truncated outputs
   - Flag tasks with ungrounded responses (requires RAG integration)

**Success criteria:**
- Every task run captures LLM usage telemetry
- Grafana dashboards show token usage, tool call patterns, finish reasons
- Privacy filtering prevents leaking sensitive prompt content

**Dependencies:**
- None (can proceed in parallel with Phase 1)

**Future extension:**
- Use LLM output patterns to auto-score task quality
- Feed quality scores back into agent selection for future tasks

---

### Phase 3: Reliability Hardening (Backlog)
**Goal:** Leverage platform improvements for crash recovery and operational safety.

#### 3.1 Monitor Subagent Announce Reliability 📡 PASSIVE IMPROVEMENT
**Priority:** P2  
**Effort:** S (0–1 day)  
**Owner:** swe-backend

**Value:** OpenClaw 2026.2.14 and 2026.2.15 added deterministic idempotency keys and retry-on-failure for subagent announcements. Reduces duplicate or missing AOF progress updates.

**Action items:**
1. Monitor post-upgrade behavior on Mule
2. Identify any local AOF de-dup workarounds and remove if redundant
3. Log metrics on announce delivery success rate

**Success criteria:**
- No duplicate or missing AOF status announcements
- Local workarounds removed (if platform now handles natively)

**Dependencies:** None (platform feature, no code changes needed)

---

#### 3.2 Leverage Outbound Write-Ahead Delivery Queue 💾 CRASH RECOVERY
**Priority:** P2  
**Effort:** XS (0–0.5 day)  
**Owner:** swe-backend

**Value:** OpenClaw 2026.2.13 added write-ahead queue for outbound messages. Prevents lost AOF status announcements across Mule restarts or crashes.

**Action items:**
1. Verify AOF doesn't implement redundant queueing
2. Monitor announce delivery across gateway restarts
3. Simplify AOF code if platform now handles this natively

**Success criteria:**
- AOF announcements survive gateway restarts without duplication
- Code is simpler (platform does the work)

**Dependencies:** None

---

#### 3.3 Optional: Suppress Non-Critical Tool Errors 🔇 UX POLISH
**Priority:** P3  
**Effort:** XS (0.5 day)  
**Owner:** swe-backend

**Value:** Reduce user-visible noise for background tool failures during agent runs.

**Action items:**
1. Enable `messages.suppressToolErrors` in AOF config
2. Test that critical errors still surface appropriately
3. Document behavior in user guide

**Success criteria:**
- Users don't see spammy tool error messages during normal agent runs
- Critical errors still surface for debugging

**Dependencies:** None

---

## Dependency Graph

```
Phase 1 (Sprint 2):
┌─────────────────────────────────────┐
│ 1.1 Fix Tool Visibility (BLOCKER)  │──┐
└─────────────────────────────────────┘  │
                                          │
┌─────────────────────────────────────┐  │
│ 1.2 Safe Config Patching            │  │
└─────────────────────────────────────┘  │
                                          │
┌─────────────────────────────────────┐  │
│ 1.3 Verify Gateway Permissions      │  │
└─────────────────────────────────────┘  │
                                          │
Phase 2 (Post-Sprint 2):                │
                                          │
┌─────────────────────────────────────┐  │
│ 2.1 Nested Sub-Agents               │◄─┘ (blocked by 1.1)
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 2.2 LLM I/O Hooks                   │ (parallel, no blocker)
└─────────────────────────────────────┘

Phase 3 (Backlog):
┌─────────────────────────────────────┐
│ 3.1 Monitor Announce Reliability    │
│ 3.2 Leverage WAL Queue               │
│ 3.3 Suppress Tool Errors (optional)  │
└─────────────────────────────────────┘
```

---

## Sprint 2 Scope

**In scope:**
- 1.1 Fix tool visibility bug (P0, BLOCKER)
- 1.2 Safe config patching (P0, quick win)
- 1.3 Verify gateway tool permissions (P0, reliability)

**Out of scope (defer to next sprint):**
- 2.1 Nested sub-agents (blocked by 1.1)
- 2.2 LLM I/O hooks (valuable but not blocking current work)

**Rationale:** Sprint 2 focuses on unblocking Project Xray and preventing operational incidents. Phase 2 items are high-value but not urgent — we want nested sub-agents working on a solid foundation.

---

## Estimated Total Effort

| Phase | Total Effort | Timeline |
|-------|-------------|----------|
| Phase 1 (Sprint 2) | S+M+S = ~4–6 days | 1 sprint |
| Phase 2 | M/H + M = ~5–10 days | 1–2 sprints |
| Phase 3 | S+XS+XS = ~1–2 days | Opportunistic |

**Total:** ~10–18 days of engineering work across 2–3 sprints.

---

## Open Questions for Architect

1. **Session tree structure:** When AOF dispatches an agent via `sessions_spawn`, is the new session a child of the AOF session or a sibling? This affects `tools.sessions.visibility=tree` behavior.

2. **Tool registration scope:** Are AOF tools (`aof_task_complete`, etc.) registered globally or per-session? If per-session, do sub-agents inherit them?

3. **Depth-aware tool policy:** Does OpenClaw's new depth-aware tool policy require explicit re-registration for sub-agents, or is inheritance automatic?

4. **Config template strategy:** Should AOF ship multiple config templates (basic, nested, advanced) or a single template with commented options?

5. **LLM hook privacy model:** What's the default policy for storing prompt content? Metadata only? Full prompts with PII filtering? Configurable per-deployment?

---

## Success Metrics

**Phase 1 success:**
- ✅ Sub-agents reliably call `aof_task_complete` (bug fixed)
- ✅ No config edits delete unintended agents (safety)
- ✅ Zero dispatch failures due to missing tool permissions

**Phase 2 success:**
- ✅ AOF agents can spawn sub-agents (depth=2) without issues
- ✅ LLM telemetry visible in Grafana dashboards
- ✅ Task quality scoring uses LLM output metadata

**Phase 3 success:**
- ✅ Zero lost announcements across gateway restarts
- ✅ Reduced operational noise (duplicate/missing updates)

---

## Alignment with "Govern Memory, Not Own Retrieval" Pivot

*Note: The vision doc mentions this pivot but doesn't elaborate. Assuming it means: AOF shouldn't implement its own RAG/retrieval layer; instead, it should govern how agents access external memory systems.*

**How these features support that pivot:**

1. **LLM I/O hooks:** AOF can observe *when* agents retrieve context and *what* they do with it, without owning the retrieval mechanism. This enables governance: track context usage patterns, flag over-retrieval, measure retrieval quality.

2. **Nested sub-agents:** Agents can delegate retrieval tasks to specialized sub-agents (e.g., "research-agent" spawns "rag-agent"). AOF governs the delegation but doesn't own the RAG implementation.

3. **Tool visibility scoping:** Ensures agents can't bypass governance by directly accessing tools outside their authorized scope. Deterministic routing = deterministic governance.

**Implication:** These features make AOF a better orchestration + observability layer *around* retrieval, not a replacement *for* it. This is architecturally sound and aligns with "don't own what you can govern."

---

## Post-Feature-Complete Sprints

Once AOF is feature complete, two dedicated sprints before any new feature work:

### Sprint H: Hardening & Resiliency
- Chaos testing: kill agents mid-task, corrupt frontmatter, simulate network partitions
- Lease/heartbeat edge cases: split-brain, clock skew, concurrent writes
- Retry storm prevention: backoff, circuit breakers, dead-letter thresholds
- Error taxonomy: classify every failure mode, ensure correct recovery path
- Session cleanup: orphaned session detection and reaping
- Graceful degradation: AOF keeps functioning when Ollama/Leto is down, when gateway is overloaded
- Load testing: 50+ concurrent tasks, sustained throughput over hours
- Observability gaps: ensure every failure path emits structured events

### Sprint R: Refactoring & Cleanup
- Dead code removal: unused exports, stale interfaces, deprecated paths
- Dead doc cleanup: outdated design docs, stale briefs, orphaned mailbox items
- Consolidate test helpers: reduce duplication across 138+ test files
- Simplify config surface: remove unused options, tighten schemas
- Dependency audit: unused packages, version bumps, license check
- Code structure: flatten unnecessary abstraction layers, rename unclear modules
- README/CONTRIBUTING refresh: accurate setup, architecture diagram, onboarding guide

**Rationale:** Feature velocity created necessary technical debt. These sprints pay it down before the next feature cycle, preventing compounding complexity.

---

## Next Actions

1. **PO** → Review and approve this roadmap
2. **Architect** → Answer open questions (session tree structure, tool registration scope)
3. **PM** → Schedule Phase 1 items for Sprint 2
4. **swe-backend** → Begin Phase 1.1 (tool visibility bug) immediately
5. **swe-qa** → Design integration tests for tool visibility at multiple depths

---

## Document History

| Date | Change | Author |
|------|--------|--------|
| 2026-02-16 | Initial version | swe-po |
