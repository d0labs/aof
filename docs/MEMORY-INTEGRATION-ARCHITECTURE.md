> **Internal document** — context-specific details may not apply to general deployments.

# AOF Memory Integration Architecture

**Date**: 2026-02-12
**Status**: Design approved
**Authors**: AOF core team
**Supersedes**: `MEMORY-ADAPTER-SPEC.md` (standalone LanceDB adapter approach)

---

## Executive Summary

AOF manages memory **structure, governance, and lifecycle** — not retrieval. The host platform (OpenClaw) owns retrieval and agent tools. AOF integrates by writing into the host's memory system and scheduling curation tasks through its existing dispatch pipeline.

This replaces the earlier "standalone adapter" approach which would have created a parallel retrieval system that agents would forget to query.

---

## Design Principles

1. **Single memory system** — agents search once, find everything. No parallel datastores.
2. **AOF governs, host retrieves** — AOF decides what to store, promote, and prune. The host platform handles indexing, embedding, and recall.
3. **Files remain source of truth** for AOF internal data (tasks, org chart, projects, events). No migration to a database.
4. **Adaptive curation** — curation pressure scales with datastore size. Small deployments lose nothing. Large deployments plateau naturally.
5. **AOF has no agents** — it creates tasks and dispatches them. The host platform provides the agents, credentials, and runtime.

---

## Architecture

### Two Data Classes

| Class | Source of Truth | Searchable Via | Lifecycle |
|-------|----------------|---------------|-----------|
| **AOF internal state** (tasks, org chart, projects, schedules) | Filesystem (YAML/MD) | File scanning + Zod parsing | Managed by AOF directly |
| **Knowledge** (decisions, preferences, learned facts, entity context) | Host memory system (e.g., OpenClaw LanceDB) | Host platform's recall tools | Governed by AOF curation pipeline |

AOF internal state may be **mirrored** into the host memory system for agent discoverability, but the files remain canonical. If the mirror is lost, it's rebuilt from files.

### Host Integration Paths

AOF must adapt to whichever memory backend the host provides:

| Host Backend | Write Path | Read Path | Scoping |
|-------------|-----------|----------|---------|
| **OpenClaw memory-core** | AOF writes markdown files, configures `memorySearch.extraPaths` | memory-core indexes files, agents use `memory_search` / `memory_get` | Per-agent via extraPaths |
| **OpenClaw memory-lancedb** | AOF writes entries via task-dispatched agents using `memory_store` tool | Plugin auto-recall injects relevant memories into context | Global (single table) |
| **No host / standalone** | AOF manages files only | Filesystem access (no semantic recall) | N/A |

### What AOF Does NOT Do

- ❌ Run its own vector database or embedding pipeline
- ❌ Provide retrieval tools to agents
- ❌ Own agent credentials or runtime
- ❌ Replace or wrap the host's memory tools

---

## Curation Pipeline (Medallion Reimagined)

Medallion architecture is repurposed from storage tiering to **curation governance**. The host memory system is flat (no tiers at query time). AOF provides the lifecycle management that prevents unbounded growth and quality degradation.

### Adaptive Pressure Model

Curation aggressiveness scales with datastore size:

| Store Size | Curation Interval | Strategy | Rationale |
|-----------|-------------------|----------|-----------|
| < 100 entries | None | No curation | Everything fits. Don't lose signal. |
| 100–500 | Monthly | Dedup only | Light maintenance, preserve recall |
| 500–2,000 | Weekly | Dedup + merge similar + expire low-importance | Active management |
| 2,000+ | Daily | Aggressive: summarize clusters, enforce budgets, retire | Plateau enforcement |

Result: datastore tends toward a soft ceiling where inflow ≈ outflow. Small deployments accumulate freely. Large deployments are kept lean.

### Curation Policy Schema

```yaml
schemaVersion: 1
description: "Adaptive curation policy for memory management"
strategy: prune  # prune | archive | compress
thresholds:
  - maxEntries: 100
    interval: 30d
  - maxEntries: 500
    interval: 7d
  - maxEntries: 2000
    interval: 1d
guardrails:
  preserveTags: [decision, preference]  # never auto-prune these tags
  preserveRecent: 7d                    # never prune entries modified within this window
  minEntries: 50                        # never delete below this count
  maxDeletePerRun: 100                  # safety limit per curation run
poolOverrides:                          # optional per-pool overrides
  - poolId: hot
    disabled: true                      # disable curation for this pool
metadata: {}
```

**Implementation:** See `src/memory/curation-policy.ts` for full schema and parser.

### Execution Model

1. **Deterministic evaluation** (AOF scheduler, no LLM):
   - Count entries (via host API or file count)
   - Compare against policy thresholds
   - Decide: skip, or create maintenance task

2. **Task creation** (AOF, no LLM):
   - If curation needed: create a task with specific instructions
   - Route to the org chart role responsible for memory curation
   - Include flagged entries (duplicates, expired, low-importance clusters)

3. **Agent execution** (host platform):
   - Dispatched agent uses host memory tools (`memory_recall`, `memory_store`, `memory_forget`)
   - Performs dedup, merge, summarize, retire per task instructions
   - AOF has no visibility into agent credentials or tool implementations

4. **Audit** (AOF event log):
   - All curation actions logged to JSONL event log
   - Mutations are traceable and reversible

### What This Means for Existing AOF Memory Primitives

| Primitive | Status | Change |
|-----------|--------|--------|
| Memory pools (hot/warm/cold) | **Keep** | Reframe: curation policies per pool, not storage tiers |
| Org-chart scoping | **Keep** | Governs who can write to which pool, curation role assignment |
| `memorySearch.extraPaths` generation | **Keep** | Still needed for memory-core integration path |
| `MemoryRetrievalAdapter` interface | **Retire or simplify** | AOF doesn't do retrieval. Replace with `MemoryWriter` interface if needed. |
| `FilesystemAdapter` | **Keep as fallback** | Standalone/no-host mode |
| `LanceDbAdapter` (standalone) | **Retire** | AOF doesn't run its own LanceDB. Writes go through host. |
| Medallion pipeline (promote/demote) | **Repurpose** | Curation governance, not storage tiering |
| `adapter-factory.ts` | **Retire or simplify** | May become a host-detection utility instead |

---

## OpenClaw memory-lancedb Plugin Reference

For architect/PO context — what the host plugin actually provides:

- **Storage**: Single `memories` table in LanceDB at `~/.openclaw/memory/lancedb`
- **Schema**: `{ id, text, vector, importance, category, createdAt }`
- **Categories**: preference, fact, decision, entity, other
- **Embeddings**: OpenAI only (text-embedding-3-small or large)
- **Auto-capture**: Rule-based pattern matching (preferences, contacts, decisions), max 3/conversation
- **Auto-recall**: Embeds user prompt → vector search → injects `<relevant-memories>` before agent starts
- **Duplicate detection**: 0.95 similarity threshold on store
- **Tools**: `memory_recall`, `memory_store`, `memory_forget`
- **No curation**: No TTL, no expiration, no compaction, no retention limits, no scoping
- **No per-agent isolation**: Single shared table

Full reference: `~/.openclaw/workspace/memory/openclaw-memory-mechanics.md`

---

## Implementation Status & Open Questions

### ✅ Resolved

1. **Host detection** — Implemented via `src/memory/host-detection.ts`. Reads `~/.openclaw/openclaw.json` and detects active memory plugin (memory-lancedb, memory-core, or filesystem).

2. **Curation role** — Implemented via `memoryCuration` field in org chart schema. Specifies `policyPath` and `role` for curation task routing.

3. **Code retirement** — Completed. Standalone LanceDB adapter and adapter-factory removed. FilesystemAdapter kept as fallback. (See QA-REPORT-TASK-2026-02-12-005.md)

4. **Curation schema** — Implemented. `CurationPolicy` schema defined in `src/memory/curation-policy.ts`. Standalone YAML file with adaptive thresholds, guardrails, and pool overrides.

5. **Curation task generation** — Implemented via `src/memory/curation-generator.ts` and `aof memory curate` CLI command.

### ⚠️ Still Open

1. **Should AOF mirror internal state into the host memory system?** Pro: agents find everything in one place. Con: duplication, sync complexity. Is file-based AOF state searchable enough via memory-core's extraPaths?

2. **Active dispatch dependency** — curation requires AOF to dispatch tasks to agents. Active dispatch is not yet fully integrated (scheduler scans but doesn't spawn). Currently, curation can be triggered manually via CLI or cron.

---

## Implementation References

**Core files:**
- `src/memory/curation-policy.ts` — Policy schema and parser
- `src/memory/host-detection.ts` — Backend detection
- `src/memory/curation-generator.ts` — Task generator
- `src/schemas/org-chart.ts` — `memoryCuration` field
- `src/cli/index.ts` — `aof memory curate` command

**Documentation:**
- `README.md` — User-facing CLI docs
- `QA-REPORT-TASK-2026-02-12-005.md` — Adapter retirement verification

**Tests:** 1216 passing (as of 2026-02-12)

---

*This document captures the 2026-02-12 design session. It reflects a significant pivot from the standalone adapter approach to host-integrated governance.*
