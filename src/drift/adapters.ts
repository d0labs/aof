/**
 * Drift Adapters — Load OpenClaw agent list from different sources
 * 
 * - FixtureAdapter: reads from JSON file (for testing)
 * - LiveAdapter: calls `openclaw agents list --json` (for production)
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { z } from "zod";
import type { OpenClawAgent } from "./detector.js";

/** OpenClaw agent schema validator */
const OpenClawAgentSchema = z.object({
  id: z.string(),
  name: z.string().optional().default("Unknown"),
  creature: z.string().optional().default("agent"),
  active: z.boolean().optional().default(true),
});

const OpenClawAgentsArraySchema = z.array(OpenClawAgentSchema);

/**
 * Base adapter interface
 */
export interface AgentAdapter {
  getAgents(): Promise<OpenClawAgent[]>;
}

/**
 * Fixture adapter — loads from JSON file
 */
export class FixtureAdapter implements AgentAdapter {
  constructor(private fixturePath: string) {}

  async getAgents(): Promise<OpenClawAgent[]> {
    try {
      const content = readFileSync(this.fixturePath, "utf-8");
      const data = JSON.parse(content);
      
      // Validate schema
      const result = OpenClawAgentsArraySchema.safeParse(data);
      if (!result.success) {
        throw new Error(`Invalid fixture schema: ${result.error.message}`);
      }
      
      return result.data;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load fixture: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Live adapter — calls `openclaw agents list --json`
 */
export class LiveAdapter implements AgentAdapter {
  async getAgents(): Promise<OpenClawAgent[]> {
    try {
      const output = execSync("openclaw agents list --json", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000, // 5 second timeout to prevent hanging
      });

      // Extract JSON part (handles config warnings printed to stdout before JSON)
      const jsonStart = Math.min(
        output.indexOf("[") === -1 ? Infinity : output.indexOf("["),
        output.indexOf("{") === -1 ? Infinity : output.indexOf("{")
      );
      
      if (jsonStart === Infinity) {
        throw new Error("No JSON found in output");
      }
      
      const cleanOutput = output.substring(jsonStart);
      const data = JSON.parse(cleanOutput);
      
      // Validate schema
      const result = OpenClawAgentsArraySchema.safeParse(data);
      if (!result.success) {
        throw new Error(`Invalid OpenClaw output: ${result.error.message}`);
      }
      
      return result.data;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get live agents: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Factory function to create adapter based on source type
 */
export function createAdapter(source: "fixture" | "live", fixturePath?: string): AgentAdapter {
  if (source === "fixture") {
    if (!fixturePath) {
      throw new Error("Fixture path required when source is 'fixture'");
    }
    return new FixtureAdapter(fixturePath);
  }
  
  return new LiveAdapter();
}
