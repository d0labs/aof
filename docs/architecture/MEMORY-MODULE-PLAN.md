# AOF Memory Module — Architecture & Implementation Plan

**Date**: 2026-02-17  
**Architect**: AOF core team
**Status**: Design approved, tasks created

---

## Executive Summary

AOF becomes the OpenClaw memory plugin (`kind: "memory"`), replacing memory-core/QMD/lancedb with a unified system that provides:

- **Files as source of truth** — memories remain markdown files in pools/tiers
- **Hybrid search** — BM25 keyword + vector similarity (sub-second performance)
- **Configurable embeddings** — OpenAI API, Ollama, any OpenAI-compatible endpoint
- **Medallion integration** — tier-aware scoring, optional curation pipeline
- **Module isolation** — memory v1 works standalone (zero deps on dispatch/scheduler/murmur)

**Implementation**: 21 beads tasks, estimated 6-8 hours of focused engineering work.

---

## Architectural Decisions

### 1. Module Isolation (CRITICAL)

Memory module is **completely independent** of other AOF primitives. This enables incremental adoption — users can enable just `modules.memory.enabled` without the untested orchestration primitives.

**Module boundaries**:
- ✅ Memory module: embeddings, store, search, tools, index sync
- ✅ Medallion modules: hot-promotion, warm-aggregation, cold-tier, curation-policy (independent)
- ⚠️  Curation-generator: depends on ITaskStore → **phase 2** (requires both memory + dispatch enabled)

**Design constraint**: The plugin's `register()` function conditionally registers tools/services based on `config.modules.<name>.enabled`. No circular dependencies.

### 2. Embedding Provider

**NEW interface** (not MemoryRetrievalAdapter):

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}
```

**Rationale**: MemoryRetrievalAdapter is for search backends. Embedding provider is a simpler, lower-level primitive. Batch support for efficient indexing.

**Implementations**:
- OpenAIEmbeddingProvider (~150 LOC) — works with OpenAI, Ollama, vLLM, any `/v1/embeddings` endpoint
- Future: LocalEmbeddingProvider (node-llama-cpp for offline use)

### 3. Storage Layer

**Vector store**: SQLite + sqlite-vec extension  
**BM25 search**: SQLite FTS5  
**Hybrid scoring**: Weighted combine + tier boosting

**Schema**:
- `chunks` table: file_path, chunk_index, content, embedding (BLOB), tier, pool, importance, tags, timestamps
- `files` table: path, hash (SHA-256 for change detection), chunk_count, tier, pool, indexed_at
- `vec_chunks` virtual table: sqlite-vec for vector search
- `fts_chunks` virtual table: FTS5 for keyword search

**Dependencies**:
- sqlite-vec (v0.1.7-alpha.2, MIT/Apache) — add as npm dependency
- better-sqlite3 (already in AOF dependencies)

### 4. Index Scope

**Global** (per OpenClaw instance). SQLite DB sits in AOF dataDir, indexes all configured pools. Matches memory-lancedb pattern and makes sense for shared knowledge across agents.

### 5. Transition Strategy

Both memory-core and AOF memory can coexist during development. Users switch by changing `plugins.slots.memory: "aof"` in openclaw.json. No data migration needed (fresh index on first memory_search).

### 6. Pool Definitions

Defined in **memory module config**, not inherited from scheduler. Memory owns its pool registry. This maintains module independence.

Config example:
```json
{
  "plugins": {
    "slots": { "memory": "aof" },
    "entries": {
      "aof": {
        "config": {
          "modules": {
            "memory": { "enabled": true }
          },
          "memory": {
            "embedding": {
              "provider": "openai",
              "model": "nomic-embed-text",
              "baseUrl": "http://100.91.2.71:11434/v1",
              "apiKey": "ollama"
            },
            "search": {
              "hybridEnabled": true,
              "vectorWeight": 0.7,
              "bm25Weight": 0.3,
              "tierBoost": {
                "hot": 1.0,
                "warm": 0.8,
                "cold": 0.5
              }
            },
            "indexPaths": [
              "~/.openclaw/agents/*/workspace",
              "~/Documents/notes"
            ]
          }
        }
      }
    }
  }
}
```

### 7. Tier Metadata Source

Read from file **frontmatter** (`tier: hot|warm|cold`) or infer from pool default. No dependency on medallion state. This keeps memory standalone.

---

## Module Structure (500 LOC Compliance)

```
src/memory/
  embeddings/
    provider.ts              # Interface (~30 LOC)
    openai-provider.ts       # HTTP client (~150 LOC)
  
  store/
    schema.ts                # SQLite schema (~100 LOC)
    vector-store.ts          # sqlite-vec CRUD (~250 LOC)
    fts-store.ts             # FTS5 operations (~120 LOC)
    hybrid-search.ts         # Combined search + tier boost (~180 LOC)
  
  chunking/
    chunker.ts               # Markdown-aware (~150 LOC)
    hash.ts                  # Change detection (~80 LOC)
  
  tools/
    search.ts                # memory_search (~120 LOC)
    get.ts                   # memory_get (~80 LOC)
    store.ts                 # memory_store (~150 LOC)
    update.ts                # memory_update (~120 LOC)
    delete.ts                # memory_delete (~80 LOC)
    list.ts                  # memory_list (~100 LOC)
  
  services/
    index-sync.ts            # Periodic reindex (~180 LOC)
  
  memory-module.ts           # Module registration (~250 LOC)
  
  # Existing medallion modules (keep as-is)
  hot-promotion.ts           # 209 LOC ✅
  warm-aggregation.ts        # 247 LOC ✅
  cold-tier.ts               # 118 LOC ✅
  curation-policy.ts         # 210 LOC ✅
  curation-generator.ts      # 347 LOC ✅ (phase 2 integration)
  generator.ts               # 263 LOC ✅
  audit.ts                   # 187 LOC ✅
  host-detection.ts          # 149 LOC ✅
  adapter.ts                 # 90 LOC ✅ (keep for phase 2)
  adapters/filesystem.ts     # ~80 LOC ✅ (keep for fallback)
```

**Total**:
- New memory system: ~2190 LOC
- Existing medallion: ~1840 LOC
- Grand total: ~4030 LOC (all files <500 LOC ✅)

---

## Tools (OpenClaw Plugin SDK)

| Tool | Args | Description |
|------|------|-------------|
| `memory_search` | `query, maxResults?, minScore?, tiers?, poolIds?` | Hybrid BM25 + vector search. Returns ranked snippets with path + line numbers. Tier-boosted scoring. |
| `memory_get` | `path, from?, lines?` | Read specific file with optional line range. Must match existing OpenClaw contract for backward compat. |
| `memory_store` | `content, path?, pool?, tier?, tags?, importance?` | Write memory to file + embed. Auto-assigns path if not given. |
| `memory_update` | `path, content?, tags?, importance?, tier?` | Update existing memory file. Re-chunks and re-embeds changed content. |
| `memory_delete` | `path` | Delete memory file + remove vectors from index. |
| `memory_list` | `pool?, tier?, tags?, limit?` | List memories with metadata. Medallion-aware filtering. |

---

## Implementation Plan

### Phase 1: Foundation (5 tasks, ~2-3 hours)

| Task | Description | LOC | File |
|------|-------------|-----|------|
| AOF-j2v | Add sqlite-vec dependency, verify macOS ARM compatibility | - | package.json |
| AOF-28g | Update config schema (modules.memory, embedding, search) | - | package.json, openclaw.plugin.json |
| AOF-7sr | Embedding provider interface | 30 | src/memory/embeddings/provider.ts |
| AOF-329 | SQLite schema + migrations | 100 | src/memory/store/schema.ts |
| AOF-ce1 | Markdown chunker | 150 | src/memory/chunking/chunker.ts |
| AOF-obq | File hash tracker | 80 | src/memory/chunking/hash.ts |

**Ready to start immediately** (no blockers).

### Phase 2: Embedding & Store (4 tasks, ~1.5-2 hours)

| Task | Description | Depends On |
|------|-------------|------------|
| AOF-e7a | OpenAI-compatible embedding provider | AOF-7sr |
| AOF-wek | Vector store CRUD (sqlite-vec) | AOF-329, AOF-j2v |
| AOF-ncc | FTS5 store operations | AOF-329 |
| AOF-2qx | Hybrid search engine | AOF-wek, AOF-ncc |

**Unblocked after phase 1 completes.**

### Phase 3: Tools (6 tasks, ~1.5-2 hours)

| Task | Description | Depends On |
|------|-------------|------------|
| AOF-ffu | memory_get tool | (none) |
| AOF-ko6 | memory_list tool | AOF-329 |
| AOF-o6i | memory_delete tool | AOF-wek, AOF-ncc |
| AOF-uz3 | memory_update tool | AOF-ce1, AOF-obq, AOF-wek, AOF-ncc |
| AOF-e3t | memory_store tool | AOF-ce1, AOF-obq, AOF-wek, AOF-ncc, AOF-e7a |
| AOF-34z | memory_search tool | AOF-2qx, AOF-e7a |

**Can run in parallel once dependencies are met.**

### Phase 4: Integration (2 tasks, ~1 hour)

| Task | Description | Depends On |
|------|-------------|------------|
| AOF-tyn | Index sync service | AOF-obq, AOF-ce1, AOF-e7a, AOF-wek, AOF-ncc |
| AOF-a39 | Module registration + plugin wiring | All tools + AOF-tyn |

**Final integration step.**

### Phase 5: Testing & Docs (4 tasks, ~1.5-2 hours)

| Task | Description | Depends On |
|------|-------------|------------|
| AOF-tjq | Unit tests for embeddings | AOF-7sr, AOF-e7a |
| AOF-71h | Unit tests for stores | AOF-wek, AOF-ncc, AOF-2qx |
| AOF-oj6 | Integration test (full pipeline) | AOF-a39 |
| AOF-2kb | README documentation | AOF-a39 |

**Can start unit tests early (parallel with phase 3). Integration test and docs at the end.**

---

## Critical Issues Flagged

### 1. Curation-Generator Dependency ⚠️

**Issue**: `curation-generator.ts` imports `ITaskStore` from the task system, creating a circular dependency that violates module isolation.

**Resolution**: For v1 standalone memory, curation-generator should only register if **BOTH** memory AND dispatch modules are enabled. Document this in phase 2 integration tasks.

**Action**: Add task in phase 2 for conditional curation-generator wiring (not part of v1).

### 2. Backward Compatibility ⚠️

**Issue**: Need to verify `memory_get` and `memory_search` tool signatures match current OpenClaw contracts.

**Resolution**: Backend agent should check `api.runtime.tools.createMemorySearchTool()` source for expected params before implementing.

**Action**: Include in tool implementation task briefs.

### 3. sqlite-vec Platform Test ⚠️

**Issue**: Must verify sqlite-vec works on macOS ARM and Linux x64 before considering tasks complete.

**Resolution**: AOF-j2v includes explicit platform testing. If manual builds required, escalate immediately.

**Action**: Test on local macOS ARM first, then verify on Linux in CI.

### 4. Pool Config vs Scheduler ⚠️

**Issue**: Design decision needed — should memory pools be independent of scheduler pools, or reference the same definitions?

**Resolution**: Memory module has its own pool config initially (in `config.memory.indexPaths`). Can unify in phase 2 if both modules are enabled. This maintains module independence for v1.

**Action**: Document in config schema task (AOF-28g).

---

## Success Criteria

- ✅ `memory_search "what vector DB did we choose?"` returns relevant results in <1 second
- ✅ Files remain on disk, readable without the plugin
- ✅ Switching embedding provider requires only config change (no code/restart beyond gateway restart)
- ✅ Curation tasks (dedup, prune) keep vector index consistent (phase 2)
- ✅ Existing agents using memory_search/memory_get work without changes
- ✅ All modules <500 LOC, all functions <120 LOC
- ✅ Full test coverage for store, search, embedding, and index sync
- ✅ Memory module works standalone with zero dependencies on dispatch/scheduler/murmur

---

## Dependency Graph

```
Foundation (parallel):
  AOF-j2v (sqlite-vec dependency)
  AOF-28g (config schema)
  AOF-7sr (embedding interface)
  AOF-329 (SQLite schema)
  AOF-ce1 (chunker)
  AOF-obq (hash tracker)
  
Layer 2:
  AOF-e7a (OpenAI provider) ← AOF-7sr
  AOF-wek (vector store) ← AOF-329, AOF-j2v
  AOF-ncc (FTS5 store) ← AOF-329

Layer 3:
  AOF-2qx (hybrid search) ← AOF-wek, AOF-ncc

Tools (parallel after dependencies):
  AOF-ffu (memory_get) ← (none)
  AOF-ko6 (memory_list) ← AOF-329
  AOF-o6i (memory_delete) ← AOF-wek, AOF-ncc
  AOF-uz3 (memory_update) ← AOF-ce1, AOF-obq, AOF-wek, AOF-ncc
  AOF-e3t (memory_store) ← AOF-ce1, AOF-obq, AOF-wek, AOF-ncc, AOF-e7a
  AOF-34z (memory_search) ← AOF-2qx, AOF-e7a

Services:
  AOF-tyn (index sync) ← AOF-obq, AOF-ce1, AOF-e7a, AOF-wek, AOF-ncc

Integration:
  AOF-a39 (module registration) ← all tools + AOF-tyn

Testing:
  AOF-tjq (embedding tests) ← AOF-7sr, AOF-e7a
  AOF-71h (store tests) ← AOF-wek, AOF-ncc, AOF-2qx
  AOF-oj6 (integration test) ← AOF-a39

Docs:
  AOF-2kb (README) ← AOF-a39
```

---

## Next Steps

1. **Start phase 1 foundation tasks** (AOF-j2v, AOF-28g, AOF-7sr, AOF-329, AOF-ce1, AOF-obq) — all ready to start immediately
2. **Review this plan** with project lead for approval
3. **Spawn swe-backend** for implementation (or start with AOF-j2v as a quick validation task)
4. **Iterative review** after each phase completes

---

**END OF PLAN**
