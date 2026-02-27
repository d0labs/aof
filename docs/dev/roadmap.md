---
title: "AOF Roadmap"
description: "Project roadmap and milestone tracking."
---

## Memory: True Medallion Architecture

**Status:** Planned
**Priority:** High
**Current state:** Three-tier storage (hot/warm/cold) with hybrid search, tier boosting, and rule-based aggregation. Promotion is manual/gated. No memory pressure management.

### What "true medallion" means

The current tier system stores and retrieves, but doesn't distill knowledge. A true medallion architecture would:

1. **LLM-based summarization** — When warm tier grows, summarize clusters of related entries into distilled knowledge docs. Not string concatenation, actual semantic compression.

2. **Memory pressure management** — Track total size, query latency, and hit rates per tier. When a tier exceeds its budget, trigger compaction automatically.

3. **Pressure-driven compaction** — Warm entries that are frequently retrieved get promoted to hot (with LLM summary). Cold entries that haven't been accessed in N days get archived or pruned. The aggressiveness of compaction scales with pressure.

4. **Auto-managed serving tiers** — No manual promotion. The system observes access patterns and moves entries between tiers automatically. Hot stays small and high-signal. Warm is the working set. Cold is the archive.

5. **Access-based demotion** — Hot entries that stop being queried gradually demote to warm. Warm entries that go stale demote to cold.

6. **Budget-aware hot tier** — The 50KB hot cap exists but has no overflow strategy. When hot is full and a new entry needs promotion, the system should identify the least-accessed hot entry and demote it.

### Implementation phases

| Phase | What | Depends on |
|-------|------|------------|
| M1 | Memory pressure metrics (size, hit rate, latency per tier) | — |
| M2 | Access tracking (per-entry read counts, last accessed timestamp) | M1 |
| M3 | Auto-demotion (hot → warm → cold based on access decay) | M2 |
| M4 | LLM summarization for warm → hot promotion | M1 |
| M5 | Pressure-triggered compaction (auto-summarize when warm exceeds budget) | M1, M4 |
| M6 | Full auto-managed medallion (no manual promotion needed) | M2, M3, M4, M5 |

---

## `aof init` Integration Wizard

**Status:** In progress
**Priority:** High

Upgrade `aof init` from project scaffolding to a full OpenClaw integration wizard:
- Register plugin in openclaw.json (via CLI, never direct JSON edits)
- Interactive memory plugin swap (detect existing, warn, disable, register AOF)
- Companion skill import
- Allow list management
- Idempotent re-runs

---

## npm Publish

**Status:** Blocked on `aof init` completion
**Priority:** High

Publish `aof` to npm. Package is ready (494 kB, files allowlist, exports map, peer deps set). Awaiting final `aof init` wizard before first publish.

---

## Dev Tooling Reusable Skill

**Status:** Planned
**Priority:** Medium

Extract the dev tooling setup (conventional commits, semantic versioning, release-it, git hooks) into a reusable OpenClaw skill that can be applied to any future software project.
