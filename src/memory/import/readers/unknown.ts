/**
 * Fallback reader for unrecognized SQLite schemas.
 * Scans all tables for text-heavy columns and extracts rows.
 * Best-effort extraction — results may need manual review.
 */

import type Database from "better-sqlite3";

export interface UnknownRow {
  table: string;
  rowIndex: number;
  text: string;
}

/** Extract text content from any table that has a TEXT-heavy column. */
export function extractUnknownSchema(db: Database.Database): {
  rows: UnknownRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const rows: UnknownRow[] = [];

  const tables: string[] = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  ).map(r => r.name);

  for (const table of tables) {
    // Skip FTS shadow tables and virtual tables.
    if (table.includes("_fts") || table.includes("_vec")) continue;

    let cols: Array<{ name: string; type: string }>;
    try {
      cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
    } catch {
      continue;
    }

    // Find TEXT columns likely to contain meaningful content.
    const textCols = cols
      .filter(c => c.type.toUpperCase().includes("TEXT") || c.type === "")
      .map(c => c.name)
      .filter(n => ["text", "content", "body", "data", "value", "message"].includes(n.toLowerCase()));

    if (textCols.length === 0) continue;

    const col = textCols[0]!;
    warnings.push(`best-effort extraction from table "${table}", column "${col}"`);

    try {
      const tableRows = db.prepare(`SELECT ${col} AS text FROM ${table} WHERE ${col} IS NOT NULL AND length(${col}) > 20`).all() as Array<{ text: string }>;
      for (let i = 0; i < tableRows.length; i++) {
        rows.push({ table, rowIndex: i, text: tableRows[i]!.text });
      }
    } catch {
      warnings.push(`failed to read from table "${table}"`);
    }
  }

  return { rows, warnings };
}
