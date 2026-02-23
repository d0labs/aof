/**
 * Write orphaned chunk text to MEMORY.md format files.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { OrphanChunk } from "./types.js";

export interface WriteResult {
  written: number;
  path: string;
}

/**
 * Build markdown content for a group of orphan chunks from one source file.
 */
function buildSection(sourcePath: string, chunks: OrphanChunk[], date: string): string {
  const lines: string[] = [
    `## Imported memories (orphaned from: ${sourcePath})`,
    `<!-- Imported by aof memory import on ${date} -->`,
    "",
  ];

  for (const chunk of chunks) {
    lines.push(chunk.text.trimEnd());
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Append orphan chunks to a target markdown file.
 * Groups chunks by their source path.
 * If dryRun is true, returns counts without writing anything.
 */
export async function writeOrphansToMemory(
  orphans: OrphanChunk[],
  targetPath: string,
  opts?: { dryRun?: boolean },
): Promise<WriteResult> {
  if (orphans.length === 0) {
    return { written: 0, path: targetPath };
  }

  if (opts?.dryRun) {
    return { written: orphans.length, path: targetPath };
  }

  // Group by source path, preserving insertion order.
  const grouped = new Map<string, OrphanChunk[]>();
  for (const chunk of orphans) {
    const group = grouped.get(chunk.sourcePath) ?? [];
    group.push(chunk);
    grouped.set(chunk.sourcePath, group);
  }

  const date = new Date().toISOString().slice(0, 10);

  // Build combined content.
  const sections: string[] = [];
  for (const [sourcePath, chunks] of grouped) {
    sections.push(buildSection(sourcePath, chunks, date));
  }
  const content = sections.join("\n") + "\n";

  // Ensure parent directory exists.
  await mkdir(dirname(targetPath), { recursive: true });

  // Append to file (create if not exists).
  await appendFile(targetPath, content, "utf-8");

  return { written: orphans.length, path: targetPath };
}
