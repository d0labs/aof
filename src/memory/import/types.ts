/**
 * Shared types for the memory import pipeline.
 */

export type ProviderKind = "memory-core" | "memory-lancedb" | "unknown";

export interface SqliteSource {
  agentId: string;
  sqlitePath: string;       // absolute path to .sqlite file
  workspacePath: string;    // base dir for resolving relative file paths
}

export interface IndexedFile {
  rawPath: string;          // path as stored in SQLite (may be relative)
  resolvedPath: string;     // absolute resolved path
  existsOnDisk: boolean;
  chunkCount: number;       // number of chunks in DB for this file
}

export interface OrphanChunk {
  chunkId: string;
  text: string;
  sourcePath: string;       // file path that no longer exists on disk
}

export interface AgentImportResult {
  agentId: string;
  sqlitePath: string;
  providerKind: ProviderKind;
  filesIndexed: number;
  filesOnDisk: number;
  filesMissing: number;
  orphanChunks: number;
  orphanChunksWritten: number;
  outputPath?: string;
  warnings: string[];
  errors: string[];
}

export interface ImportReport {
  dryRun: boolean;
  agents: AgentImportResult[];
  totalFilesIndexed: number;
  totalFilesMissing: number;
  totalOrphansWritten: number;
  errors: string[];
}
