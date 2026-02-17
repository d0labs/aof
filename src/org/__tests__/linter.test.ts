import { describe, it, expect } from "vitest";
import { lintOrgChart } from "../linter.js";
import { OrgChart } from "../../schemas/org-chart.js";

function makeChart(overrides: Record<string, unknown> = {}): ReturnType<typeof OrgChart.parse> {
  return OrgChart.parse({
    schemaVersion: 1,
    teams: [
      { id: "swe", name: "SWE", lead: "architect" },
      { id: "ops", name: "Ops" },
    ],
    agents: [
      { id: "main", name: "Main", team: "ops", active: true },
      { id: "architect", name: "Architect", team: "swe", reportsTo: "main", canDelegate: true, active: true },
      { id: "backend", name: "Backend", team: "swe", reportsTo: "architect", active: true },
    ],
    routing: [
      { matchTags: ["backend"], targetAgent: "backend", weight: 10 },
      { matchTags: ["ops"], targetTeam: "ops", weight: 10 },
    ],
    ...overrides,
  });
}

describe("lintOrgChart", () => {
  it("passes a valid org chart with no issues", () => {
    const issues = lintOrgChart(makeChart());
    const errors = issues.filter(i => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("detects invalid reportsTo reference", () => {
    const chart = makeChart({
      agents: [
        { id: "main", name: "Main", active: true },
        { id: "bad", name: "Bad", reportsTo: "nonexistent", active: true },
      ],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-reports-to")).toBe(true);
  });

  it("detects invalid team lead", () => {
    const chart = makeChart({
      teams: [{ id: "swe", name: "SWE", lead: "ghost" }],
      agents: [{ id: "main", name: "Main", team: "swe", active: true }],
      routing: [],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-team-lead")).toBe(true);
  });

  it("detects agent in nonexistent team", () => {
    const chart = makeChart({
      teams: [],
      agents: [{ id: "main", name: "Main", team: "fake-team", active: true }],
      routing: [],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-agent-team")).toBe(true);
  });

  it("detects routing to nonexistent agent", () => {
    const chart = makeChart({
      routing: [{ matchTags: ["x"], targetAgent: "ghost", weight: 10 }],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-routing-target")).toBe(true);
  });

  it("detects routing to nonexistent team", () => {
    const chart = makeChart({
      routing: [{ matchTags: ["x"], targetTeam: "phantom", weight: 10 }],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-routing-target")).toBe(true);
  });

  it("detects role mappings to missing agents", () => {
    const chart = makeChart({
      roles: {
        backend: { agents: ["ghost-agent"] },
      },
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-role-agent")).toBe(true);
  });

  it("detects circular reporting chains", () => {
    const chart = makeChart({
      teams: [{ id: "swe", name: "SWE" }],
      agents: [
        { id: "a", name: "A", team: "swe", reportsTo: "b", active: true },
        { id: "b", name: "B", team: "swe", reportsTo: "a", active: true },
      ],
      routing: [],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "no-circular-reports")).toBe(true);
  });

  it("detects self-reporting", () => {
    const chart = makeChart({
      agents: [
        { id: "main", name: "Main", active: true },
        { id: "narcissist", name: "N", reportsTo: "narcissist", active: true },
      ],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "no-self-report")).toBe(true);
  });

  it("warns about routing to inactive agents", () => {
    const chart = makeChart({
      agents: [
        { id: "main", name: "Main", team: "ops", active: true },
        { id: "retired", name: "Retired", team: "swe", active: false },
      ],
      routing: [{ matchTags: ["x"], targetAgent: "retired", weight: 10 }],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "inactive-routing-target")).toBe(true);
  });

  it("validates context budget policy thresholds (target < warn < critical)", () => {
    const chart = makeChart({
      agents: [
        {
          id: "main",
          name: "Main",
          active: true,
          policies: {
            context: {
              target: 10000,
              warn: 5000, // warn < target (invalid)
              critical: 15000,
            },
          },
        },
      ],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-context-budget-thresholds")).toBe(true);
  });

  it("validates context budget policy thresholds (warn < critical)", () => {
    const chart = makeChart({
      agents: [
        {
          id: "main",
          name: "Main",
          active: true,
          policies: {
            context: {
              target: 10000,
              warn: 20000,
              critical: 15000, // critical < warn (invalid)
            },
          },
        },
      ],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-context-budget-thresholds")).toBe(true);
  });

  it("validates context budget policy in defaults", () => {
    const chart = makeChart({
      defaults: {
        policies: {
          context: {
            target: 20000,
            warn: 10000, // warn < target (invalid)
            critical: 30000,
          },
        },
      },
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-context-budget-thresholds")).toBe(true);
  });

  it("accepts valid context budget policy", () => {
    const chart = makeChart({
      agents: [
        {
          id: "main",
          name: "Main",
          active: true,
          policies: {
            context: {
              target: 10000,
              warn: 20000,
              critical: 30000,
            },
          },
        },
      ],
    });
    const issues = lintOrgChart(chart);
    expect(issues.some(i => i.rule === "valid-context-budget-thresholds")).toBe(false);
  });
});
