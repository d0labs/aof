/**
 * Gate transition handler — orchestrates gate evaluation and task state updates.
 *
 * Integrates gate evaluator into scheduler lifecycle. When a task completes at a gate,
 * this module loads the workflow config, evaluates the transition, updates task state,
 * and emits telemetry.
 *
 * This is the glue between the pure gate evaluation logic and the filesystem-backed
 * task store. Designed for atomic operations and resilience.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { TaskStore } from "../store/task-store.js";
import type { EventLogger } from "../events/logger.js";
import type { Task, TaskStatus } from "../schemas/task.js";
import { evaluateGateTransition, type GateEvaluationInput, type GateEvaluationResult } from "./gate-evaluator.js";
import { validateWorkflow, type WorkflowConfig } from "../schemas/workflow.js";
import { ProjectManifest } from "../schemas/project.js";
import type { GateOutcome, GateTransition } from "../schemas/gate.js";
import type { AOFMetrics } from "../metrics/exporter.js";

/**
 * Load project manifest from project.yaml.
 *
 * @param projectRoot - Root directory of the project
 * @returns Parsed and validated project manifest
 * @throws Error if project.yaml is missing or invalid
 */
export async function loadProjectManifest(projectRoot: string): Promise<ProjectManifest> {
  const projectPath = join(projectRoot, "project.yaml");
  
  try {
    const yaml = await readFile(projectPath, "utf-8");
    const parsed = parseYaml(yaml) as unknown;
    
    // Validate with Zod schema
    return ProjectManifest.parse(parsed);
  } catch (err) {
    const error = err as Error;
    throw new Error(`Failed to load project manifest from ${projectPath}: ${error.message}`);
  }
}

/**
 * Apply gate transition updates to task (atomic write).
 *
 * Updates task frontmatter with gate state, routing, history, and review context.
 * Uses atomic file write to ensure consistency.
 *
 * @param store - Task store instance
 * @param task - Task to update
 * @param result - Gate evaluation result with task updates
 */
async function applyGateTransition(
  store: TaskStore,
  task: Task,
  result: GateEvaluationResult
): Promise<void> {
  const updates = result.taskUpdates;
  
  // Handle status transition first (if needed)
  if (updates.status) {
    const newStatus = updates.status as TaskStatus;
    if (task.frontmatter.status !== newStatus) {
      await store.transition(task.frontmatter.id, newStatus, {
        reason: `gate_${result.transition.outcome}`,
      });
      // Reload task after transition
      const reloadedTask = await store.get(task.frontmatter.id);
      if (!reloadedTask) {
        throw new Error(`Task ${task.frontmatter.id} not found after transition`);
      }
      // Copy the updated task state back
      task.frontmatter = reloadedTask.frontmatter;
      task.body = reloadedTask.body;
      task.path = reloadedTask.path;
    }
  }
  
  // Apply all other updates AFTER status transition/reload
  if (updates.gate) {
    task.frontmatter.gate = updates.gate;
  }
  if (updates.routing) {
    task.frontmatter.routing = {
      ...task.frontmatter.routing,
      ...updates.routing,
    };
  }
  if (updates.gateHistory) {
    task.frontmatter.gateHistory = updates.gateHistory;
  }
  // reviewContext can be explicitly undefined to clear it
  if ("reviewContext" in updates) {
    task.frontmatter.reviewContext = updates.reviewContext;
  }
  
  // Update timestamp
  task.frontmatter.updatedAt = new Date().toISOString();
  
  // Write task atomically using serializeTask and writeFileAtomic
  const { serializeTask } = await import("../store/task-store.js");
  const writeFileAtomic = (await import("write-file-atomic")).default;
  const filePath = task.path ?? join(store.projectRoot, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
  await writeFileAtomic(filePath, serializeTask(task));
}

/**
 * Handle task completion at a gate.
 *
 * Orchestrates the full gate transition flow:
 * 1. Load task from store
 * 2. Load project manifest to get workflow config
 * 3. Validate workflow configuration
 * 4. Evaluate gate transition (pure logic)
 * 5. Apply task updates atomically
 * 6. Emit gate transition event
 * 7. Record Prometheus metrics (if metrics instance provided)
 *
 * @param store - Task store instance
 * @param logger - Event logger instance
 * @param taskId - Task ID completing the gate
 * @param outcome - Gate outcome (complete | needs_review | blocked)
 * @param context - Completion context (summary, blockers, etc.)
 * @param metrics - Optional metrics instance for Prometheus telemetry
 * @returns Gate transition result
 * @throws Error if task not found, no workflow, or invalid workflow
 */
export async function handleGateTransition(
  store: TaskStore,
  logger: EventLogger,
  taskId: string,
  outcome: GateOutcome,
  context: {
    summary: string;
    blockers?: string[];
    rejectionNotes?: string;
    agent?: string;
  },
  metrics?: AOFMetrics
): Promise<GateTransition> {
  // Load task
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  
  // Check if task is in a gate (backward compatibility)
  if (!task.frontmatter.gate) {
    throw new Error(`Task ${taskId} is not in a gate workflow`);
  }
  
  // Load project manifest to get workflow config
  const projectManifest = await loadProjectManifest(store.projectRoot);
  if (!projectManifest.workflow) {
    throw new Error(`Project ${store.projectId} has no workflow configured`);
  }
  
  const workflow = projectManifest.workflow;
  
  // Validate workflow (defensive check)
  const workflowErrors = validateWorkflow(workflow);
  if (workflowErrors.length > 0) {
    throw new Error(`Invalid workflow: ${workflowErrors.join(", ")}`);
  }
  
  // Evaluate gate transition
  const input: GateEvaluationInput = {
    task,
    workflow,
    outcome,
    summary: context.summary,
    blockers: context.blockers,
    rejectionNotes: context.rejectionNotes,
    agent: context.agent,
  };
  
  const result = evaluateGateTransition(input);
  
  // Apply task updates atomically
  await applyGateTransition(store, task, result);
  
  // Emit gate transition event
  await logger.log("gate_transition", context.agent ?? "system", {
    taskId: task.frontmatter.id,
    payload: {
      fromGate: result.transition.fromGate,
      toGate: result.transition.toGate,
      outcome,
      agent: context.agent,
      duration: result.transition.duration,
      skipped: result.skippedGates,
    },
  });
  
  // Record Prometheus metrics (if metrics instance provided)
  if (metrics) {
    const project = task.frontmatter.project ?? store.projectId;
    const workflowName = workflow.name;
    
    // Record gate duration (if available)
    if (result.transition.duration !== undefined && result.transition.fromGate) {
      metrics.recordGateDuration(
        project,
        workflowName,
        result.transition.fromGate,
        outcome,
        result.transition.duration
      );
    }
    
    // Record gate transition
    if (result.transition.fromGate && result.transition.toGate) {
      metrics.recordGateTransition(
        project,
        workflowName,
        result.transition.fromGate,
        result.transition.toGate,
        outcome
      );
    }
    
    // Record rejection (needs_review outcome with fromGate)
    if (outcome === "needs_review" && result.transition.fromGate) {
      // Determine rejecting role from routing (who it's being sent back to)
      const rejectedByRole = task.frontmatter.routing?.agent ?? "unknown";
      metrics.recordGateRejection(
        project,
        workflowName,
        result.transition.fromGate,
        rejectedByRole
      );
    }
  }
  
  return result.transition;
}
