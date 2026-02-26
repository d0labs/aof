/**
 * AOF Install Wizard
 * Guided setup for new AOF installations.
 */

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { OrgChart } from "../schemas/org-chart.js";
import { lintOrgChart } from "../org/linter.js";

export interface WizardOptions {
  /** Installation directory (e.g., ~/Projects/AOF) */
  installDir: string;
  /** Template name (minimal or full) */
  template: "minimal" | "full";
  /** Interactive mode (prompts for user input) */
  interactive: boolean;
  /** Skip OpenClaw integration detection */
  skipOpenClaw?: boolean;
  /** Home directory (for OpenClaw detection, defaults to os.homedir()) */
  homeDir?: string;
  /** Run health check after installation */
  healthCheck?: boolean;
  /** Force overwrite if installation exists */
  force?: boolean;
}

export interface WizardResult {
  success: boolean;
  installDir: string;
  created: string[];
  orgChartPath?: string;
  openclawDetected?: boolean;
  healthCheck?: boolean;
  warnings?: string[];
}

export interface OpenClawDetectionResult {
  detected: boolean;
  configPath?: string;
  workspaceDir?: string;
}

/**
 * Run the installation wizard.
 */
export async function runWizard(opts: WizardOptions): Promise<WizardResult> {
  const {
    installDir,
    template,
    interactive,
    skipOpenClaw = false,
    homeDir = homedir(),
    healthCheck = false,
    force = false,
  } = opts;

  const created: string[] = [];
  const warnings: string[] = [];

  // Check if installation already exists
  const orgChartPath = join(installDir, "org", "org-chart.yaml");
  if (!force) {
    try {
      await access(orgChartPath);
      throw new Error(`Installation already exists at ${installDir}. Use --force to overwrite.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // Directory doesn't exist, proceed
    }
  }

  // Detect OpenClaw
  let openclawDetected = false;
  if (!skipOpenClaw) {
    const detection = await detectOpenClaw(homeDir);
    openclawDetected = detection.detected;
    if (openclawDetected && interactive) {
      // In interactive mode, could prompt user here
      // For now, just note it in warnings
      warnings.push("OpenClaw detected. Integration available.");
    }
  }

  // Create directory structure
  const directories = [
    "tasks/backlog",
    "tasks/ready",
    "tasks/in-progress",
    "tasks/review",
    "tasks/blocked",
    "tasks/done",
    "events",
    "data",
    "org",
    "memory",
    "state",
    "logs",
  ];

  for (const dir of directories) {
    const fullPath = join(installDir, dir);
    await mkdir(fullPath, { recursive: true });
    created.push(`${dir}/`);
  }

  // Create .gitignore
  const gitignorePath = join(installDir, ".gitignore");
  const gitignoreContent = `# AOF Runtime Data
events/
data/
memory/
state/
logs/
.aof-state
*.log
*.db
*.dat

# Backups
.aof-backup/

# Dependencies
node_modules/
`;

  await writeFile(gitignorePath, gitignoreContent, "utf-8");
  created.push(".gitignore");

  // Generate org chart from template
  const orgChart = await generateOrgChart(template);
  await writeFile(orgChartPath, stringifyYaml(orgChart), "utf-8");
  created.push("org/org-chart.yaml");

  // Validate generated org chart
  const parseResult = OrgChart.safeParse(orgChart);
  if (!parseResult.success) {
    throw new Error(`Generated org chart is invalid: ${parseResult.error.message}`);
  }

  const lintIssues = lintOrgChart(parseResult.data);
  if (lintIssues.length > 0) {
    warnings.push(`Org chart has ${lintIssues.length} lint issues`);
  }

  // Create README.md
  const readmePath = join(installDir, "README.md");
  const readmeContent = `# AOF Installation

Template: ${template}
Created: ${new Date().toISOString()}

## Getting Started

1. Review your org chart: \`org/org-chart.yaml\`
2. Create your first task: \`tasks/ready/001-first-task.md\`
3. Run the scheduler: \`aof scheduler run\`

## Directory Structure

- \`tasks/\` — Task files organized by status
- \`org/\` — Organization chart and agent definitions
- \`events/\` — Event log (runtime data)
- \`data/\` — Persistent data (runtime state)

## Documentation

See https://github.com/xavierxeon/aof for full documentation.
`;

  await writeFile(readmePath, readmeContent, "utf-8");
  created.push("README.md");

  // Run health check if requested
  let healthCheckPassed = false;
  if (healthCheck) {
    healthCheckPassed = await performHealthCheck(installDir, orgChartPath);
  }

  return {
    success: true,
    installDir,
    created,
    orgChartPath,
    openclawDetected,
    healthCheck: healthCheckPassed || undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Detect OpenClaw installation.
 */
export async function detectOpenClaw(homeDir: string = homedir()): Promise<OpenClawDetectionResult> {
  const openclawDir = join(homeDir, ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");

  try {
    await access(configPath);
    
    // Check for workspace directory
    const workspaceDir = join(openclawDir, "workspace");
    try {
      await access(workspaceDir);
      return {
        detected: true,
        configPath,
        workspaceDir,
      };
    } catch {
      return {
        detected: true,
        configPath,
      };
    }
  } catch {
    return {
      detected: false,
    };
  }
}

/**
 * Generate org chart from template.
 */
async function generateOrgChart(template: "minimal" | "full"): Promise<Record<string, unknown>> {
  if (template === "minimal") {
    return {
      schemaVersion: 1,
      template: "minimal",
      teams: [
        {
          id: "main",
          name: "Main Team",
          description: "Primary operating team",
        },
      ],
      agents: [
        {
          id: "main",
          name: "Main Agent",
          description: "Primary orchestration agent",
          team: "main",
          canDelegate: false,
          active: true,
          capabilities: {
            tags: ["orchestration", "coordination"],
            concurrency: 1,
          },
          comms: {
            preferred: "cli",
            fallbacks: ["cli"],
          },
        },
      ],
      routing: [],
      metadata: {
        template: "minimal",
        generated: new Date().toISOString(),
      },
    };
  }

  // Full template with multiple agents
  return {
    schemaVersion: 1,
    template: "full",
    teams: [
      {
        id: "ops",
        name: "Operations",
        description: "Operations and coordination",
        lead: "main",
      },
      {
        id: "execution",
        name: "Execution",
        description: "Task execution team",
        lead: "executor",
      },
    ],
    agents: [
      {
        id: "main",
        name: "Main Agent",
        description: "Strategic coordinator and orchestrator",
        team: "ops",
        canDelegate: true,
        active: true,
        capabilities: {
          tags: ["orchestration", "delegation", "coordination"],
          concurrency: 3,
        },
        comms: {
          preferred: "send",
          fallbacks: ["send", "cli"],
        },
      },
      {
        id: "executor",
        name: "Executor Agent",
        description: "Task execution specialist",
        team: "execution",
        reportsTo: "main",
        canDelegate: false,
        active: true,
        capabilities: {
          tags: ["execution", "implementation"],
          concurrency: 2,
        },
        comms: {
          preferred: "cli",
          fallbacks: ["cli"],
        },
      },
      {
        id: "reviewer",
        name: "Reviewer Agent",
        description: "Quality assurance and review",
        team: "execution",
        reportsTo: "main",
        canDelegate: false,
        active: true,
        capabilities: {
          tags: ["review", "qa", "validation"],
          concurrency: 1,
        },
        comms: {
          preferred: "cli",
          fallbacks: ["cli"],
        },
      },
    ],
    routing: [
      {
        matchTags: ["execution", "implementation"],
        targetAgent: "executor",
        weight: 10,
      },
      {
        matchTags: ["review", "qa"],
        targetAgent: "reviewer",
        weight: 10,
      },
    ],
    metadata: {
      template: "full",
      generated: new Date().toISOString(),
    },
  };
}

/**
 * Perform health check on installation.
 */
async function performHealthCheck(installDir: string, orgChartPath: string): Promise<boolean> {
  try {
    // Verify org chart exists and is valid
    const content = await readFile(orgChartPath, "utf-8");
    const orgChart = await import("yaml").then(m => m.parse(content));
    
    const parseResult = OrgChart.safeParse(orgChart);
    if (!parseResult.success) {
      return false;
    }

    // Verify directory structure
    const requiredDirs = [
      "tasks",
      "org",
      "events",
      "data",
    ];

    for (const dir of requiredDirs) {
      await access(join(installDir, dir));
    }

    return true;
  } catch {
    return false;
  }
}
