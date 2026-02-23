/**
 * Main entry point for the memory import pipeline.
 * Orchestrates: detect → open → read → audit → extract → write.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectSqliteSources } from "./detector.js";
import { auditFiles } from "./audit.js";
import { writeOrphansToMemory } from "./writer.js";
import { createMemoryCoreReader } from "./readers/memory-core.js";
import { extractUnknownSchema } from "./readers/unknown.js";
import type { AgentImportResult, ImportReport, OrphanChunk, ProviderKind } from "./types.js";

export type { ImportReport, AgentImportResult } from "./types.js";

export interface MemoryImportOptions {
  sourceDir?: string;
  workspacePath?: string;
  dryRun?: boolean;
  agentFilter?: string;
  noOrphans?: boolean;
  configPath?: string;
}

function importDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runMemoryImport(opts: MemoryImportOptions = {}): Promise<ImportReport> {
  const {
    sourceDir,
    workspacePath = join(homedir(), ".openclaw", "workspace"),
    dryRun = false,
    agentFilter,
    noOrphans = false,
    configPath,
  } = opts;

  const sources = await detectSqliteSources({ configPath, memoryDir: sourceDir, agentFilter });

  const agents: AgentImportResult[] = [];
  const topErrors: string[] = [];
  const reader = createMemoryCoreReader();

  for (const source of sources) {
    const result: AgentImportResult = {
      agentId: source.agentId,
      sqlitePath: source.sqlitePath,
      providerKind: "unknown" as ProviderKind,
      filesIndexed: 0,
      filesOnDisk: 0,
      filesMissing: 0,
      orphanChunks: 0,
      orphanChunksWritten: 0,
      warnings: [],
      errors: [],
    };

    let db: InstanceType<typeof Database> | undefined;
    try {
      db = new Database(source.sqlitePath, { readonly: true });

      // Detect provider kind.
      if (reader.isCompatible(db)) {
        result.providerKind = "memory-core";
      } else {
        result.providerKind = "unknown";
        result.warnings.push("Unrecognized schema — using best-effort extraction");
      }

      // Read indexed files.
      let rawFiles: Array<{ path: string; chunkCount: number }>;
      if (result.providerKind === "memory-core") {
        rawFiles = reader.readFiles(db);
      } else {
        // For lancedb or unknown, stub out files list.
        if ((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .some(r => r.name === "lancedb_vectors")) {
          result.providerKind = "memory-lancedb";
          result.warnings.push("lanceDB import not yet supported — audit only");
        }
        const { rows, warnings } = extractUnknownSchema(db);
        result.warnings.push(...warnings);
        rawFiles = rows.map(r => ({ path: `${r.table}[${r.rowIndex}]`, chunkCount: 1 }));
      }

      // Audit files against disk.
      const audited = await auditFiles(rawFiles, source.workspacePath);
      result.filesIndexed = audited.length;
      result.filesOnDisk = audited.filter(f => f.existsOnDisk).length;
      result.filesMissing = audited.filter(f => !f.existsOnDisk).length;

      // Extract and write orphans.
      if (!noOrphans && result.filesMissing > 0 && result.providerKind === "memory-core") {
        const missingPaths = new Set(
          audited.filter(f => !f.existsOnDisk).map(f => f.rawPath)
        );

        const orphanRows = reader.readOrphans(db, missingPaths);
        result.orphanChunks = orphanRows.length;

        if (orphanRows.length > 0) {
          const orphans: OrphanChunk[] = orphanRows.map(r => ({
            chunkId: r.chunkId,
            text: r.text,
            sourcePath: r.sourcePath,
          }));

          const targetPath = join(workspacePath, "memory", `import-${importDate()}.md`);
          const writeResult = await writeOrphansToMemory(orphans, targetPath, { dryRun });
          result.orphanChunksWritten = writeResult.written;
          result.outputPath = writeResult.path;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(msg);
      topErrors.push(`${source.agentId}: ${msg}`);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }

    agents.push(result);
  }

  return {
    dryRun,
    agents,
    totalFilesIndexed: agents.reduce((s, a) => s + a.filesIndexed, 0),
    totalFilesMissing: agents.reduce((s, a) => s + a.filesMissing, 0),
    totalOrphansWritten: agents.reduce((s, a) => s + a.orphanChunksWritten, 0),
    errors: topErrors,
  };
}
