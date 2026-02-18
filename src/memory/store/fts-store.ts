import type Database from "better-sqlite3";

import { parseTags, serializeTags } from "./tag-serialization";

const INSERT_SQL =
  "INSERT INTO fts_chunks(rowid, content, file_path, tags) VALUES (?, ?, ?, ?)";
const DELETE_SQL = "DELETE FROM fts_chunks WHERE rowid = ?";
const DELETE_BY_FILE_SQL = "DELETE FROM fts_chunks WHERE file_path = ?";
const SEARCH_SQL = `
  SELECT
    rowid as chunkId,
    content,
    file_path as filePath,
    tags,
    bm25(fts_chunks) as bm25
  FROM fts_chunks
  WHERE fts_chunks MATCH ?
  ORDER BY bm25
  LIMIT ?
`;

export type FtsChunkInput = {
  chunkId: number;
  content: string;
  filePath: string;
  tags?: string[] | null;
};

export type FtsSearchResult = {
  chunkId: number;
  content: string;
  filePath: string;
  tags: string[] | null;
  bm25: number;
};

type FtsSearchRow = {
  chunkId: number;
  content: string;
  filePath: string;
  tags: string | null;
  bm25: number;
};

export class FtsStore {
  private readonly insertStmt;
  private readonly deleteStmt;
  private readonly deleteByFileStmt;
  private readonly searchStmt;

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.deleteStmt = db.prepare(DELETE_SQL);
    this.deleteByFileStmt = db.prepare(DELETE_BY_FILE_SQL);
    this.searchStmt = db.prepare(SEARCH_SQL);
  }

  insertChunk(input: FtsChunkInput): void {
    this.insertStmt.run(
      input.chunkId,
      input.content,
      input.filePath,
      serializeTags(input.tags)
    );
  }

  deleteChunk(chunkId: number): void {
    this.deleteStmt.run(chunkId);
  }

  deleteChunksByFile(filePath: string): number {
    const result = this.deleteByFileStmt.run(filePath);
    return result.changes;
  }

  search(query: string, limit: number): FtsSearchResult[] {
    if (!query.trim()) {
      return [];
    }

    const rows = this.searchStmt.all(query, limit) as FtsSearchRow[];
    return rows.map((row) => ({
      chunkId: row.chunkId,
      content: row.content,
      filePath: row.filePath,
      tags: parseTags(row.tags),
      bm25: row.bm25,
    }));
  }
}
