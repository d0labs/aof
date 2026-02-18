import { readFile } from "node:fs/promises";

import type { OpenClawToolDefinition, ToolResult } from "../../openclaw/types.js";

type MemoryGetParams = {
  path: string;
  from?: number;
  lines?: number;
};

const buildResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const sliceLines = (content: string, from?: number, lines?: number): string => {
  if (!from && !lines) {
    return content;
  }

  const allLines = content.split(/\r?\n/);
  const start = Math.max(1, from ?? 1);
  const end = lines ? start + lines - 1 : allLines.length;

  return allLines.slice(start - 1, end).join("\n");
};

export const memoryGetTool: OpenClawToolDefinition = {
  name: "memory_get",
  description: "Read a file from memory storage with an optional line range.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to read (required)",
      },
      from: {
        type: "number",
        description: "1-based starting line number",
      },
      lines: {
        type: "number",
        description: "Number of lines to return",
      },
    },
    required: ["path"],
  },
  execute: async (_id: string, params: Record<string, unknown>) => {
    const { path, from, lines } = params as MemoryGetParams;

    try {
      const content = await readFile(path, "utf-8");
      return buildResult(sliceLines(content, from, lines));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return buildResult(`File not found: ${path}`);
      }

      throw error;
    }
  },
};
