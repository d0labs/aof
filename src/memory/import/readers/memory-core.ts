/**
 * Reader for memory-core-compatible SQLite schemas.
 * Uses PRAGMA introspection — never hardcodes column names.
 */

import type Database from "better-sqlite3";

export interface FileRow {
  path: string;
  chunkCount: number;
}

export interface ChunkRow {
  chunkId: string;
  text: string;
  sourcePath: string;
}

interface SchemaInfo {
  filesPathCol: string;
  chunksTextCol: string;
  chunksPathCol: string;
  chunksIdCol: string;
}

/** Inspect DB schema and return column mappings, or null if incompatible. */
function inspectSchema(db: Database.Database): SchemaInfo | null {
  const tables: string[] = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map(r => r.name);

  if (!tables.includes("files") || !tables.includes("chunks")) return null;

  const filesCols = (
    db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>
  ).map(r => r.name);

  const chunksCols = (
    db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>
  ).map(r => r.name);

  if (!filesCols.includes("path")) return null;

  // Find text column in chunks: prefer 'text', then 'content', then 'body'.
  const textCol = ["text", "content", "body"].find(c => chunksCols.includes(c));
  if (!textCol) return null;

  // Find path column in chunks: prefer 'path', then 'file_path'.
  const pathCol = ["path", "file_path"].find(c => chunksCols.includes(c));
  if (!pathCol) return null;

  // Find id column in chunks: prefer 'id', then 'chunk_id'.
  const idCol = ["id", "chunk_id"].find(c => chunksCols.includes(c)) ?? "rowid";

  return {
    filesPathCol: "path",
    chunksTextCol: textCol,
    chunksPathCol: pathCol,
    chunksIdCol: idCol,
  };
}

export interface MemoryCoreReader {
  isCompatible(db: Database.Database): boolean;
  readFiles(db: Database.Database): FileRow[];
  readOrphans(db: Database.Database, missingPaths: Set<string>): ChunkRow[];
}

export function createMemoryCoreReader(): MemoryCoreReader {
  return {
    isCompatible(db) {
      return inspectSchema(db) !== null;
    },

    readFiles(db) {
      const schema = inspectSchema(db);
      if (!schema) return [];

      // Get all file paths from the files table.
      const files = (
        db.prepare(`SELECT ${schema.filesPathCol} AS path FROM files`).all() as Array<{ path: string }>
      );

      // Compute chunk counts via chunks table.
      const countStmt = db.prepare(
        `SELECT ${schema.chunksPathCol} AS path, COUNT(*) AS n FROM chunks GROUP BY ${schema.chunksPathCol}`
      );
      const counts = new Map<string, number>(
        (countStmt.all() as Array<{ path: string; n: number }>).map(r => [r.path, r.n])
      );

      return files.map(f => ({
        path: f.path,
        chunkCount: counts.get(f.path) ?? 0,
      }));
    },

    readOrphans(db, missingPaths) {
      if (missingPaths.size === 0) return [];

      const schema = inspectSchema(db);
      if (!schema) return [];

      const placeholders = Array.from(missingPaths).map(() => "?").join(",");
      const sql = `
        SELECT
          ${schema.chunksIdCol}   AS chunkId,
          ${schema.chunksTextCol} AS text,
          ${schema.chunksPathCol} AS sourcePath
        FROM chunks
        WHERE ${schema.chunksPathCol} IN (${placeholders})
      `;

      const rows = db.prepare(sql).all(...Array.from(missingPaths)) as Array<{
        chunkId: string;
        text: string;
        sourcePath: string;
      }>;

      return rows.map(r => ({
        chunkId: String(r.chunkId),
        text: r.text ?? "",
        sourcePath: r.sourcePath,
      }));
    },
  };
}
