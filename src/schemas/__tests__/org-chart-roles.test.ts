import { describe, it, expect } from "vitest";
import { OrgChart, RoleMapping, validateWorkflowRoles } from "../org-chart.js";

describe("RoleMapping", () => {
  it("parses a minimal role with agents only", () => {
    const result = RoleMapping.safeParse({
      agents: ["swe-backend"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toEqual(["swe-backend"]);
      expect(result.data.description).toBeUndefined();
      expect(result.data.requireHuman).toBeUndefined();
    }
  });

  it("parses a full role with all fields", () => {
    const result = RoleMapping.safeParse({
      agents: ["swe-backend", "swe-qa"],
      description: "Backend development and testing",
      requireHuman: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toEqual(["swe-backend", "swe-qa"]);
      expect(result.data.description).toBe("Backend development and testing");
      expect(result.data.requireHuman).toBe(true);
    }
  });

  it("requires at least one agent", () => {
    const result = RoleMapping.safeParse({
      agents: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing agents field", () => {
    const result = RoleMapping.safeParse({
      description: "Some role",
    });
    expect(result.success).toBe(false);
  });
});

describe("OrgChart with roles", () => {
  it("parses org chart without roles (backward compatible)", () => {
    const chart = {
      schemaVersion: 1,
      agents: [{ id: "main", name: "Demerzel" }],
    };
    const result = OrgChart.safeParse(chart);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roles).toBeUndefined();
    }
  });

  it("parses org chart with roles", () => {
    const chart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-backend", name: "Backend Dev" },
        { id: "swe-qa", name: "QA Engineer" },
      ],
      roles: {
        backend: {
          agents: ["swe-backend"],
          description: "Backend development",
        },
        qa: {
          agents: ["swe-qa"],
          requireHuman: false,
        },
      },
    };
    const result = OrgChart.safeParse(chart);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roles).toBeDefined();
      expect(result.data.roles?.backend.agents).toEqual(["swe-backend"]);
      expect(result.data.roles?.qa.agents).toEqual(["swe-qa"]);
    }
  });

  it("allows multiple agents per role", () => {
    const chart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-backend-1", name: "Backend Dev 1" },
        { id: "swe-backend-2", name: "Backend Dev 2" },
      ],
      roles: {
        backend: {
          agents: ["swe-backend-1", "swe-backend-2"],
        },
      },
    };
    const result = OrgChart.safeParse(chart);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roles?.backend.agents).toHaveLength(2);
    }
  });
});

describe("validateWorkflowRoles", () => {
  const orgChart = {
    roles: {
      backend: { agents: ["swe-backend"] },
      qa: { agents: ["swe-qa"] },
      architect: { agents: ["swe-architect"] },
    },
  };

  it("returns no errors for valid workflow", () => {
    const workflow = {
      gates: [
        { role: "backend" },
        { role: "qa", escalateTo: "architect" },
      ],
    };
    const errors = validateWorkflowRoles(workflow, orgChart);
    expect(errors).toEqual([]);
  });

  it("detects undefined role in gate", () => {
    const workflow = {
      gates: [
        { role: "backend" },
        { role: "nonexistent" },
      ],
    };
    const errors = validateWorkflowRoles(workflow, orgChart);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("nonexistent");
  });

  it("detects undefined escalateTo role", () => {
    const workflow = {
      gates: [
        { role: "backend", escalateTo: "nonexistent" },
      ],
    };
    const errors = validateWorkflowRoles(workflow, orgChart);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("escalateTo");
    expect(errors[0]).toContain("nonexistent");
  });

  it("detects multiple undefined roles", () => {
    const workflow = {
      gates: [
        { role: "bad-role-1" },
        { role: "backend" },
        { role: "bad-role-2", escalateTo: "bad-escalate" },
      ],
    };
    const errors = validateWorkflowRoles(workflow, orgChart);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("handles workflow with no gates", () => {
    const workflow = { gates: [] };
    const errors = validateWorkflowRoles(workflow, orgChart);
    expect(errors).toEqual([]);
  });

  it("handles org chart with no roles defined", () => {
    const workflow = {
      gates: [{ role: "backend" }],
    };
    const errors = validateWorkflowRoles(workflow, {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("backend");
  });

  it("handles org chart with undefined roles field", () => {
    const workflow = {
      gates: [{ role: "backend" }],
    };
    const errors = validateWorkflowRoles(workflow, { roles: undefined });
    expect(errors).toHaveLength(1);
  });
});
