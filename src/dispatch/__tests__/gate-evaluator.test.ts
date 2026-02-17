/**
 * Gate evaluator tests — core gate progression algorithm.
 *
 * Test coverage:
 * - Complete outcome: advance to next gate
 * - Complete outcome: skip conditional gates
 * - Complete outcome: task done when no more gates
 * - Needs_review outcome: loop back to first gate
 * - Needs_review outcome: set reviewContext
 * - Blocked outcome: stay in current gate
 * - Gate history appended correctly
 * - Duration calculated correctly
 * - Skipped gates tracked
 * - Error: current gate not in workflow
 * - Edge case: all gates conditional and skipped
 * - Edge case: workflow with single gate
 * - Edge case: no gates in workflow (should error)
 */

import { describe, it, expect } from "vitest";
import { evaluateGateTransition, type GateEvaluationInput } from "../gate-evaluator.js";
import type { Task } from "../../schemas/task.js";
import type { WorkflowConfig } from "../../schemas/workflow.js";

describe("gate-evaluator", () => {
  describe("evaluateGateTransition", () => {
    describe("complete outcome", () => {
      it("should advance to next gate", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-001",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "dev" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "dev",
              entered: "2026-02-16T10:00:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "qa", role: "swe-qa", canReject: true },
            { id: "deploy", role: "swe-devops", canReject: false },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Implementation complete",
          agent: "agent-1",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("dev");
        expect(result.transition.toGate).toBe("qa");
        expect(result.transition.outcome).toBe("complete");
        expect(result.transition.taskId).toBe("TASK-2026-02-16-001");
        expect(result.transition.agent).toBe("agent-1");
        expect(result.transition.skipped).toEqual([]);
        expect(result.taskUpdates.gate).toEqual({
          current: "qa",
          entered: expect.any(String),
        });
        expect(result.taskUpdates.routing).toEqual({
          role: "swe-qa",
          workflow: "test",
        });
        expect(result.taskUpdates.gateHistory).toHaveLength(1);
        expect(result.taskUpdates.gateHistory[0]).toMatchObject({
          gate: "dev",
          role: "swe-backend",
          agent: "agent-1",
          entered: "2026-02-16T10:00:00Z",
          exited: expect.any(String),
          outcome: "complete",
          summary: "Implementation complete",
        });
        expect(result.taskUpdates.reviewContext).toBeUndefined();
        expect(result.skippedGates).toEqual([]);
      });

      it("should skip conditional gates that evaluate to false", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-002",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "dev", tags: [] },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "dev",
              entered: "2026-02-16T10:00:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "security", role: "swe-security", canReject: false, when: "tags.includes('security')" },
            { id: "qa", role: "swe-qa", canReject: true },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Implementation complete",
          agent: "agent-1",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("dev");
        expect(result.transition.toGate).toBe("qa");
        expect(result.transition.skipped).toEqual(["security"]);
        expect(result.skippedGates).toEqual(["security"]);
        expect(result.taskUpdates.gate?.current).toBe("qa");
      });

      it("should mark task done when completing last gate", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-003",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "deploy" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "deploy",
              entered: "2026-02-16T10:00:00Z",
            },
            gateHistory: [
              {
                gate: "dev",
                role: "swe-backend",
                entered: "2026-02-16T09:00:00Z",
                exited: "2026-02-16T09:30:00Z",
                outcome: "complete",
                summary: "Dev complete",
                blockers: [],
                duration: 1800,
              },
            ],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "deploy", role: "swe-devops", canReject: false },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Deployment successful",
          agent: "deploy-agent",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("deploy");
        expect(result.transition.toGate).toBeUndefined();
        expect(result.transition.outcome).toBe("complete");
        expect(result.taskUpdates.status).toBe("done");
        expect(result.taskUpdates.gate).toBeUndefined();
        expect(result.taskUpdates.gateHistory).toHaveLength(2);
      });

      it("should skip all conditional gates and complete task if all remaining gates are inactive", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-004",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "dev", tags: [] },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "dev",
              entered: "2026-02-16T10:00:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "security", role: "swe-security", canReject: false, when: "tags.includes('security')" },
            { id: "compliance", role: "compliance", canReject: false, when: "tags.includes('compliance')" },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Dev complete",
          agent: "agent-1",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("dev");
        expect(result.transition.toGate).toBeUndefined();
        expect(result.transition.skipped).toEqual(["security", "compliance"]);
        expect(result.taskUpdates.status).toBe("done");
        expect(result.skippedGates).toEqual(["security", "compliance"]);
      });
    });

    describe("needs_review outcome", () => {
      it("should loop back to first gate", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-005",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "qa" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "qa",
              entered: "2026-02-16T10:30:00Z",
            },
            gateHistory: [
              {
                gate: "dev",
                role: "swe-backend",
                entered: "2026-02-16T10:00:00Z",
                exited: "2026-02-16T10:30:00Z",
                outcome: "complete",
                summary: "Dev complete",
                blockers: [],
                duration: 1800,
              },
            ],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "qa", role: "swe-qa", canReject: true },
            { id: "deploy", role: "swe-devops", canReject: false },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "needs_review",
          summary: "Tests failing",
          blockers: ["Unit test failure in auth module"],
          rejectionNotes: "Please fix auth tests before resubmitting",
          agent: "qa-agent",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("qa");
        expect(result.transition.toGate).toBe("dev");
        expect(result.transition.outcome).toBe("needs_review");
        expect(result.taskUpdates.gate).toEqual({
          current: "dev",
          entered: expect.any(String),
        });
        expect(result.taskUpdates.routing).toEqual({
          role: "swe-backend",
          workflow: "test",
        });
        expect(result.taskUpdates.gateHistory).toHaveLength(2);
        expect(result.skippedGates).toEqual([]);
      });

      it("should set reviewContext with rejection details", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-006",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "qa" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "qa",
              entered: "2026-02-16T10:30:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "qa", role: "swe-qa", canReject: true },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "needs_review",
          summary: "Code quality issues",
          blockers: ["Missing error handling", "No input validation"],
          rejectionNotes: "Add proper error handling and input validation",
          agent: "qa-agent",
        };

        const result = evaluateGateTransition(input);

        expect(result.taskUpdates.reviewContext).toBeDefined();
        expect(result.taskUpdates.reviewContext).toMatchObject({
          fromGate: "qa",
          fromAgent: "qa-agent",
          fromRole: "swe-qa",
          timestamp: expect.any(String),
          blockers: ["Missing error handling", "No input validation"],
          notes: "Add proper error handling and input validation",
        });
      });

      it("should overwrite reviewContext on repeated rejection cycles", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-012",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "qa" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "qa",
              entered: "2026-02-16T11:00:00Z",
            },
            gateHistory: [
              {
                gate: "dev",
                role: "swe-backend",
                entered: "2026-02-16T10:00:00Z",
                exited: "2026-02-16T10:30:00Z",
                outcome: "complete",
                summary: "Dev complete",
                blockers: [],
                duration: 1800,
              },
            ],
            reviewContext: {
              fromGate: "qa",
              fromAgent: "qa-agent",
              fromRole: "swe-qa",
              timestamp: "2026-02-16T10:45:00Z",
              blockers: ["Old issue"],
              notes: "Old notes",
            },
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "qa", role: "swe-qa", canReject: true },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "needs_review",
          summary: "More issues found",
          blockers: ["New blocker"],
          rejectionNotes: "Fix new blocker",
          agent: "qa-agent-2",
        };

        const result = evaluateGateTransition(input);

        expect(result.taskUpdates.reviewContext).toMatchObject({
          fromGate: "qa",
          fromAgent: "qa-agent-2",
          fromRole: "swe-qa",
          blockers: ["New blocker"],
          notes: "Fix new blocker",
        });
        expect(result.taskUpdates.gateHistory).toHaveLength(2);
      });

      it("should loop back from final gate when needs_review", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-013",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "qa" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "qa",
              entered: "2026-02-16T12:00:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "qa", role: "swe-qa", canReject: true },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "needs_review",
          summary: "Final gate rejection",
          blockers: ["Issue found"],
          rejectionNotes: "Please fix",
          agent: "qa-agent",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("qa");
        expect(result.transition.toGate).toBe("dev");
        expect(result.taskUpdates.gate?.current).toBe("dev");
        expect(result.taskUpdates.routing?.role).toBe("swe-backend");
      });
    });

    describe("blocked outcome", () => {
      it("should stay in current gate", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-007",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "dev" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "dev",
              entered: "2026-02-16T10:00:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "qa", role: "swe-qa", canReject: true },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "blocked",
          summary: "Waiting on dependency",
          blockers: ["Blocked by TASK-2026-02-16-000"],
          agent: "agent-1",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("dev");
        expect(result.transition.toGate).toBe("dev");
        expect(result.transition.outcome).toBe("blocked");
        expect(result.taskUpdates.status).toBe("blocked");
        expect(result.taskUpdates.gate).toBeUndefined();
        expect(result.taskUpdates.gateHistory).toHaveLength(1);
        expect(result.taskUpdates.gateHistory[0]).toMatchObject({
          gate: "dev",
          outcome: "blocked",
          summary: "Waiting on dependency",
          blockers: ["Blocked by TASK-2026-02-16-000"],
        });
      });
    });

    describe("edge cases", () => {
      it("should throw error if current gate not found in workflow", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-008",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "unknown" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "unknown-gate",
              entered: "2026-02-16T10:00:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Done",
          agent: "agent-1",
        };

        expect(() => evaluateGateTransition(input)).toThrow(
          "Current gate unknown-gate not found in workflow"
        );
      });

      it("should calculate duration correctly", () => {
        const enteredTime = new Date("2026-02-16T10:00:00Z");
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-009",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "dev" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "dev",
              entered: enteredTime.toISOString(),
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Done",
          agent: "agent-1",
        };

        const result = evaluateGateTransition(input);

        // Duration should be calculated (in seconds)
        expect(result.transition.duration).toBeGreaterThan(0);
        expect(result.taskUpdates.gateHistory[0].duration).toBeGreaterThan(0);
      });

      it("should handle workflow with single gate", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-010",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "dev" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "dev",
              entered: "2026-02-16T10:00:00Z",
            },
            gateHistory: [],
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Complete",
          agent: "agent-1",
        };

        const result = evaluateGateTransition(input);

        expect(result.transition.fromGate).toBe("dev");
        expect(result.transition.toGate).toBeUndefined();
        expect(result.taskUpdates.status).toBe("done");
      });

      it("should clear reviewContext when advancing gate", () => {
        const task: Task = {
          frontmatter: {
            schemaVersion: 1,
            id: "TASK-2026-02-16-011",
            project: "test",
            title: "Test task",
            status: "in-progress",
            priority: "normal",
            routing: { workflow: "test", role: "dev" },
            createdAt: "2026-02-16T10:00:00Z",
            updatedAt: "2026-02-16T10:00:00Z",
            lastTransitionAt: "2026-02-16T10:00:00Z",
            createdBy: "system",
            gate: {
              current: "dev",
              entered: "2026-02-16T10:30:00Z",
            },
            gateHistory: [],
            reviewContext: {
              fromGate: "qa",
              fromAgent: "qa-agent",
              fromRole: "swe-qa",
              timestamp: "2026-02-16T10:25:00Z",
              blockers: ["Fix tests"],
              notes: "Tests failed",
            },
            metadata: {},
          },
          body: "Task body",
        };

        const workflow: WorkflowConfig = {
          name: "test",
          rejectionStrategy: "origin",
          gates: [
            { id: "dev", role: "swe-backend", canReject: false },
            { id: "qa", role: "swe-qa", canReject: true },
          ],
        };

        const input: GateEvaluationInput = {
          task,
          workflow,
          outcome: "complete",
          summary: "Fixed issues",
          agent: "agent-1",
        };

        const result = evaluateGateTransition(input);

        expect(result.taskUpdates.reviewContext).toBeUndefined();
      });
    });
  });
});
