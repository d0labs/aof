import { unlink } from "node:fs/promises";

import type Database from "better-sqlite3";

import type { OpenClawToolDefinition, ToolResult } from "../../openclaw/types.js";
import type { FtsStore } from "../store/fts-store.js";
import type { VectorStore } from "../store/vector-store.js";

type MemoryDeleteParams = {
  path: string;
};

type MemoryDeleteToolOptions = {
  vectorStore: VectorStore;
  ftsStore: FtsStore;
  db: Database;
};

const buildResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const deleteFileIfExists = async (filePath: string): Promise<boolean> => {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const createMemoryDeleteTool = (
  options: MemoryDeleteToolOptions,
): OpenClawToolDefinition => {
  return {
    name: "memory_delete",
    description: "Delete a memory file and purge its indexed chunks.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to delete (required)",
        },
      },
      required: ["path"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const { path } = params as MemoryDeleteParams;
      if (!path || !path.trim()) {
        return buildResult("Path is required.");
      }

      const filePath = path.trim();
      const fileDeleted = await deleteFileIfExists(filePath);

      const vectorRemoved = options.vectorStore.deleteChunksByFile(filePath);
      const ftsRemoved = options.ftsStore.deleteChunksByFile(filePath);
      const fileRows = options.db
        .prepare("DELETE FROM files WHERE path = ?")
        .run(filePath).changes;

      const removedSummary = `Removed ${vectorRemoved} vector chunks, ${ftsRemoved} fts entries, ${fileRows} file records.`;

      if (!fileDeleted) {
        return buildResult(`File not found: ${filePath}. ${removedSummary}`);
      }

      return buildResult(`Deleted memory file ${filePath}. ${removedSummary}`);
    },
  };
};
