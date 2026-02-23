/**
 * Audits indexed files: resolves paths and checks disk presence.
 */

import { access } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IndexedFile } from "./types.js";

const FALLBACK_WORKSPACE = join(homedir(), ".openclaw", "workspace");

async function existsOnDisk(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

/**
 * Resolve a raw file path to an absolute path.
 * Tries the given workspace first; falls back to FALLBACK_WORKSPACE.
 */
async function resolveFilePath(
  rawPath: string,
  workspacePath: string,
): Promise<{ resolvedPath: string; exists: boolean }> {
  if (isAbsolute(rawPath)) {
    return { resolvedPath: rawPath, exists: await existsOnDisk(rawPath) };
  }

  // Try primary workspace.
  const primary = resolve(workspacePath, rawPath);
  if (await existsOnDisk(primary)) {
    return { resolvedPath: primary, exists: true };
  }

  // Fallback: try ~/.openclaw/workspace if different from primary.
  if (workspacePath !== FALLBACK_WORKSPACE) {
    const fallback = resolve(FALLBACK_WORKSPACE, rawPath);
    if (await existsOnDisk(fallback)) {
      return { resolvedPath: fallback, exists: true };
    }
  }

  // Return primary (non-existing) as canonical resolved path.
  return { resolvedPath: primary, exists: false };
}

/**
 * Audit a list of raw file rows from a SQLite database.
 * Returns IndexedFile[] with resolved paths and disk existence status.
 */
export async function auditFiles(
  rawFiles: Array<{ path: string; chunkCount: number }>,
  workspacePath: string,
): Promise<IndexedFile[]> {
  const results: IndexedFile[] = [];

  for (const f of rawFiles) {
    const { resolvedPath, exists } = await resolveFilePath(f.path, workspacePath);
    results.push({
      rawPath: f.path,
      resolvedPath,
      existsOnDisk: exists,
      chunkCount: f.chunkCount,
    });
  }

  return results;
}
