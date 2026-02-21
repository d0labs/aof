# AOF Memory Retrieval Adapter Spec

**⚠️ SUPERSEDED** — This document is obsolete. See [MEMORY-INTEGRATION-ARCHITECTURE.md](./MEMORY-INTEGRATION-ARCHITECTURE.md) for the current design.

**Reason:** AOF no longer owns retrieval. The host platform (OpenClaw) handles retrieval, and AOF governs structure + curation through task dispatch.

---

Date: 2026-02-12
Status: ~~Draft (Phase 2)~~ **SUPERSEDED**

## Purpose
AOF owns **memory structure + policy** (tiers, pools, enrollment). Retrieval **must be pluggable and optional**. This spec defines the adapter interface and lifecycle so AOF can operate with or without a retrieval backend. The primary initial target is **LanceDB** (embeddable, local); a **filesystem-only fallback** is required.

## Non-Goals
- AOF does **not** embed a specific retrieval engine.
- AOF does **not** mandate an embedding provider (e.g., VoyageAI is an adapter detail).
- No dependency on OpenClaw memory-core or external services is required.

## Glossary
- **Pool**: A named memory slice (hot/warm/cold) mapped to a filesystem path.
- **Adapter**: Pluggable retrieval backend (semantic/keyword/graph).
- **Recall**: Search query returning contextual snippets and metadata.

---

## Interfaces & Types

### MemoryRetrievalAdapter (capability-driven)
```ts
export interface MemoryRetrievalAdapter {
  /** Stable adapter id (e.g., "filesystem", "lancedb") */
  readonly id: string;

  /** Supported recall modes */
  readonly capabilities: {
    semantic: boolean;  // vector similarity
    keyword: boolean;   // keyword/grep-like
    graph?: boolean;    // knowledge graph (optional)
  };

  /**
   * Initialize adapter. Called once at startup.
   * - dataDir: AOF runtime data dir
   * - vaultRoot: path to vault (optional)
   */
  init?(opts: { dataDir: string; vaultRoot?: string }): Promise<void>;

  /**
   * Register or update authoritative pools/paths from AOF.
   */
  registerPools(pools: MemoryPoolDefinition[]): Promise<void>;

  /**
   * Index or refresh specific paths. No-op for pull-based indexers.
   */
  indexPaths(paths: string[]): Promise<void>;

  /**
   * Recall relevant content by query and scope.
   */
  recall(query: MemoryQuery): Promise<MemoryResult[]>;

  /**
   * Optional health/diagnostics.
   */
  status?(): Promise<MemoryAdapterStatus>;
}
```

### MemoryPoolDefinition
```ts
export interface MemoryPoolDefinition {
  id: string;                       // stable pool id
  tier: "hot" | "warm" | "cold";
  path: string;                     // absolute or vault-root-resolved
  roles?: string[];                 // eligible roles
  agents?: string[];                // eligible agents
}
```

### MemoryQuery
```ts
export interface MemoryQuery {
  agentId: string;                  // caller
  query: string;                    // natural language or keywords
  limit?: number;                   // default 10
  poolIds?: string[];               // optional allowlist
  tiers?: Array<"hot" | "warm" | "cold">; // default: hot+warm
  filters?: Record<string, string | string[]>; // metadata filters
}
```

### MemoryResult
```ts
export interface MemoryResult {
  id: string;                       // backend id
  uri: string;                      // file path or logical id
  score?: number;                   // relevance
  snippet?: string;                 // excerpt for inline context
  content?: string;                 // optional full content
  metadata?: Record<string, unknown>;
}
```

### MemoryAdapterStatus
```ts
export interface MemoryAdapterStatus {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}
```

---

## Adapter Lifecycle
1. **init** (optional)
   - Called once at startup with `dataDir` and optional `vaultRoot`.
   - Adapters may open local databases, load configs, etc.
2. **registerPools**
   - Called whenever AOF generates memory pools (authoritative).
   - Adapters should reconcile indexes to these pools.
3. **indexPaths**
   - Called for explicit refreshes (e.g., CLI reindex or task lifecycle).
   - Adapters may ignore if indexing is pull-based.
4. **recall**
   - Called during context assembly (optional contribution).
   - Adapter returns `MemoryResult[]` based on `MemoryQuery`.
5. **status** (optional)
   - Health reporting for CLI diagnostics.

---

## Configuration
- New AOF config setting: `memory.adapter`.
- Supported values (initial):
  - `"filesystem"` (default fallback)
  - `"lancedb"` (primary target)
  - Future: `"memory-core"`, `"memory-x"`, etc.

Adapters **must be optional** dependencies. If a package is missing (e.g., LanceDB), AOF must continue with filesystem fallback.

---

## Fallback Behavior Contract (No Adapter / Filesystem Adapter)
AOF **must degrade gracefully** without any adapter:
- AOF continues to manage memory tiers/pools and write artifacts.
- If no adapter is configured, **no semantic recall occurs**.
- FilesystemAdapter implements `MemoryRetrievalAdapter` with:
  - `capabilities.semantic = false`, `capabilities.keyword = true`
  - `registerPools` = no-op
  - `indexPaths` = no-op
  - `recall` = keyword search (best-effort) or returns empty with warning

Context assembly **must not fail** if recall returns empty. Explicit file references continue to resolve via `FilesystemResolver`.

---

## LanceDB Adapter (Primary Target)
- Embeddable local vector DB; no external service required.
- Adapter owns embeddings + index storage under `dataDir`.
- Optional dependency (AOF must run if not installed).
- Embedding provider selection is adapter-specific (e.g., VoyageAI, OpenAI, local embeddings).

---

## Compatibility Requirements
- Works in OpenClaw runtime and containerized deployments.
- All adapters must be able to run without network access by default.
- File size <300 LOC per file (hard 500), functions <60 LOC (hard 120).

---

## Open Questions
- Should `recall` accept an explicit `mode` (semantic/keyword) or infer from adapter capabilities and query? (Default: infer.)
- Should adapters expose a `close()` lifecycle hook? (Defer until needed.)
