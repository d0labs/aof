/**
 * Tests for the memory-core SQLite reader.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createMemoryCoreReader } from "../readers/memory-core.js";

/** Build an in-memory DB with the standard memory-core schema. */
function makeDb(textCol = "text"): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      source TEXT,
      hash TEXT,
      mtime INTEGER,
      size INTEGER
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      path TEXT,
      ${textCol} TEXT,
      start_line INTEGER,
      end_line INTEGER
    );
  `);
  return db;
}

describe("createMemoryCoreReader", () => {
  let reader: ReturnType<typeof createMemoryCoreReader>;

  beforeEach(() => {
    reader = createMemoryCoreReader();
  });

  describe("isCompatible", () => {
    it("returns true for valid memory-core schema", () => {
      const db = makeDb();
      expect(reader.isCompatible(db)).toBe(true);
      db.close();
    });

    it("returns false when files table is missing", () => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE chunks (id TEXT, text TEXT, path TEXT);");
      expect(reader.isCompatible(db)).toBe(false);
      db.close();
    });

    it("returns false when chunks table is missing", () => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE files (path TEXT, hash TEXT);");
      expect(reader.isCompatible(db)).toBe(false);
      db.close();
    });

    it("returns false for unrelated schema (just a tasks table)", () => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE tasks (id TEXT, title TEXT, status TEXT);");
      expect(reader.isCompatible(db)).toBe(false);
      db.close();
    });

    it("returns false when chunks table has no text column", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE files (path TEXT);
        CREATE TABLE chunks (id TEXT, path TEXT, embedding BLOB);
      `);
      expect(reader.isCompatible(db)).toBe(false);
      db.close();
    });
  });

  describe("readFiles", () => {
    it("returns file rows with correct paths", () => {
      const db = makeDb();
      db.prepare("INSERT INTO files (path, hash) VALUES (?, ?)").run("MEMORY.md", "abc");
      db.prepare("INSERT INTO files (path, hash) VALUES (?, ?)").run("docs/guide.md", "def");

      const files = reader.readFiles(db);
      expect(files.map(f => f.path).sort()).toEqual(["MEMORY.md", "docs/guide.md"]);
      db.close();
    });

    it("computes chunk counts from chunks table", () => {
      const db = makeDb();
      db.prepare("INSERT INTO files (path) VALUES (?)").run("a.md");
      db.prepare("INSERT INTO files (path) VALUES (?)").run("b.md");
      db.prepare("INSERT INTO chunks (id, path, text) VALUES (?, ?, ?)").run("1", "a.md", "chunk one");
      db.prepare("INSERT INTO chunks (id, path, text) VALUES (?, ?, ?)").run("2", "a.md", "chunk two");
      db.prepare("INSERT INTO chunks (id, path, text) VALUES (?, ?, ?)").run("3", "b.md", "chunk three");

      const files = reader.readFiles(db);
      const a = files.find(f => f.path === "a.md")!;
      const b = files.find(f => f.path === "b.md")!;
      expect(a.chunkCount).toBe(2);
      expect(b.chunkCount).toBe(1);
      db.close();
    });

    it("returns 0 chunk count for files with no chunks", () => {
      const db = makeDb();
      db.prepare("INSERT INTO files (path) VALUES (?)").run("empty.md");

      const files = reader.readFiles(db);
      expect(files[0]!.chunkCount).toBe(0);
      db.close();
    });

    it("returns empty array for empty database", () => {
      const db = makeDb();
      expect(reader.readFiles(db)).toEqual([]);
      db.close();
    });
  });

  describe("readOrphans", () => {
    it("returns chunks for missing paths only", () => {
      const db = makeDb();
      db.prepare("INSERT INTO files (path) VALUES (?)").run("exists.md");
      db.prepare("INSERT INTO files (path) VALUES (?)").run("missing.md");
      db.prepare("INSERT INTO chunks (id, path, text) VALUES (?, ?, ?)").run("c1", "exists.md", "present");
      db.prepare("INSERT INTO chunks (id, path, text) VALUES (?, ?, ?)").run("c2", "missing.md", "orphaned");

      const orphans = reader.readOrphans(db, new Set(["missing.md"]));
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.text).toBe("orphaned");
      expect(orphans[0]!.sourcePath).toBe("missing.md");
      db.close();
    });

    it("returns empty array when no missing paths provided", () => {
      const db = makeDb();
      db.prepare("INSERT INTO chunks (id, path, text) VALUES (?, ?, ?)").run("c1", "x.md", "text");

      const orphans = reader.readOrphans(db, new Set());
      expect(orphans).toEqual([]);
      db.close();
    });

    it("handles alternate text column name 'content'", () => {
      const db = makeDb("content"); // chunks table has 'content' not 'text'
      db.prepare("INSERT INTO files (path) VALUES (?)").run("gone.md");
      db.prepare("INSERT INTO chunks (id, path, content) VALUES (?, ?, ?)").run("c1", "gone.md", "body text");

      const orphans = reader.readOrphans(db, new Set(["gone.md"]));
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.text).toBe("body text");
      db.close();
    });

    it("returns empty array when missingPaths set has no DB matches", () => {
      const db = makeDb();
      const orphans = reader.readOrphans(db, new Set(["not-in-db.md"]));
      expect(orphans).toEqual([]);
      db.close();
    });
  });
});
