import { describe, it, expect } from "vitest";
import { checkPromotionEligibility } from "../scheduler.js";
import type { Task } from "../../schemas/task.js";

describe("checkPromotionEligibility", () => {
  it("should allow promotion when all criteria met", () => {
    const task: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Test task",
        status: "backlog",
        priority: "normal",
        dependsOn: [],
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const result = checkPromotionEligibility(task, [task], new Map());
    expect(result.eligible).toBe(true);
  });

  it("should block on unresolved dependencies", () => {
    const dep: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-002",
        title: "Dependency task",
        status: "in-progress",
        priority: "normal",
        dependsOn: [],
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const task: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Main task",
        status: "backlog",
        priority: "normal",
        dependsOn: ["TASK-2026-02-14-002"],
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const result = checkPromotionEligibility(task, [task, dep], new Map());
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("dependency");
  });

  it("should block on incomplete subtasks", () => {
    const parent: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Parent task",
        status: "backlog",
        priority: "normal",
        dependsOn: [],
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const child: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-002",
        title: "Child task",
        status: "in-progress",
        priority: "normal",
        dependsOn: [],
        routing: { agent: "test-agent" },
        parentId: "TASK-2026-02-14-001",
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const childrenMap = new Map([["TASK-2026-02-14-001", [child]]]);
    const result = checkPromotionEligibility(parent, [parent, child], childrenMap);
    
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("subtask");
  });

  it("should block when no routing target", () => {
    const task: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Test task",
        status: "backlog",
        priority: "normal",
        dependsOn: [],
        routing: {},  // No agent/role/team
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const result = checkPromotionEligibility(task, [task], new Map());
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("routing target");
  });

  it("should allow promotion when dependencies are done", () => {
    const dep: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-002",
        title: "Dependency task",
        status: "done",
        priority: "normal",
        dependsOn: [],
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const task: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Main task",
        status: "backlog",
        priority: "normal",
        dependsOn: ["TASK-2026-02-14-002"],
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const result = checkPromotionEligibility(task, [task, dep], new Map());
    expect(result.eligible).toBe(true);
  });

  it("should block when dependency is missing", () => {
    const task: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Main task",
        status: "backlog",
        priority: "normal",
        dependsOn: ["TASK-2026-02-14-999"],  // Missing dependency
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const result = checkPromotionEligibility(task, [task], new Map());
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("Missing dependency");
  });

  it("should allow promotion when all subtasks are done", () => {
    const parent: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Parent task",
        status: "backlog",
        priority: "normal",
        dependsOn: [],
        routing: { agent: "test-agent" },
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const child: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-002",
        title: "Child task",
        status: "done",
        priority: "normal",
        dependsOn: [],
        routing: { agent: "test-agent" },
        parentId: "TASK-2026-02-14-001",
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const childrenMap = new Map([["TASK-2026-02-14-001", [child]]]);
    const result = checkPromotionEligibility(parent, [parent, child], childrenMap);
    
    expect(result.eligible).toBe(true);
  });

  it("should allow promotion with routing.role", () => {
    const task: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Test task",
        status: "backlog",
        priority: "normal",
        dependsOn: [],
        routing: { role: "backend" },  // Role instead of agent
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const result = checkPromotionEligibility(task, [task], new Map());
    expect(result.eligible).toBe(true);
  });

  it("should allow promotion with routing.team", () => {
    const task: Task = {
      frontmatter: {
        id: "TASK-2026-02-14-001",
        title: "Test task",
        status: "backlog",
        priority: "normal",
        dependsOn: [],
        routing: { team: "swe" },  // Team instead of agent
        createdAt: "2026-02-14T00:00:00Z",
        createdBy: "test",
        metadata: {},
      },
      body: "",
    };
    
    const result = checkPromotionEligibility(task, [task], new Map());
    expect(result.eligible).toBe(true);
  });
});
