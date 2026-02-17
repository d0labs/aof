import { describe, it, expect } from "vitest";
import { OrgChart, OrgTeam, MurmurConfig, validateTeamAgents } from "../org-chart.js";

describe("OrgTeam - orchestrator and technicalLead", () => {
  it("parses team with valid orchestrator and technicalLead", () => {
    const team = {
      id: "swe",
      name: "Software Engineering",
      orchestrator: "swe-pm",
      technicalLead: "swe-architect",
    };

    const result = OrgTeam.safeParse(team);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orchestrator).toBe("swe-pm");
      expect(result.data.technicalLead).toBe("swe-architect");
    }
  });

  it("allows team without orchestrator (backward compatibility)", () => {
    const team = {
      id: "swe",
      name: "Software Engineering",
    };

    const result = OrgTeam.safeParse(team);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orchestrator).toBeUndefined();
      expect(result.data.technicalLead).toBeUndefined();
    }
  });

  it("allows team with only orchestrator", () => {
    const team = {
      id: "swe",
      name: "Software Engineering",
      orchestrator: "swe-pm",
    };

    const result = OrgTeam.safeParse(team);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orchestrator).toBe("swe-pm");
      expect(result.data.technicalLead).toBeUndefined();
    }
  });

  it("allows team with only technicalLead", () => {
    const team = {
      id: "swe",
      name: "Software Engineering",
      technicalLead: "swe-architect",
    };

    const result = OrgTeam.safeParse(team);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orchestrator).toBeUndefined();
      expect(result.data.technicalLead).toBe("swe-architect");
    }
  });
});

describe("MurmurConfig", () => {
  it("parses murmur config with queueEmpty trigger", () => {
    const config = {
      triggers: [{ kind: "queueEmpty" }],
      context: ["vision", "roadmap"],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers).toHaveLength(1);
      expect(result.data.triggers[0].kind).toBe("queueEmpty");
      expect(result.data.context).toEqual(["vision", "roadmap"]);
    }
  });

  it("parses murmur config with completionBatch trigger", () => {
    const config = {
      triggers: [{ kind: "completionBatch", threshold: 5 }],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers[0].kind).toBe("completionBatch");
      expect(result.data.triggers[0].threshold).toBe(5);
    }
  });

  it("parses murmur config with interval trigger", () => {
    const config = {
      triggers: [{ kind: "interval", intervalMs: 3600000 }],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers[0].kind).toBe("interval");
      expect(result.data.triggers[0].intervalMs).toBe(3600000);
    }
  });

  it("parses murmur config with failureBatch trigger", () => {
    const config = {
      triggers: [{ kind: "failureBatch", threshold: 3 }],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers[0].kind).toBe("failureBatch");
      expect(result.data.triggers[0].threshold).toBe(3);
    }
  });

  it("parses murmur config with multiple triggers", () => {
    const config = {
      triggers: [
        { kind: "queueEmpty" },
        { kind: "completionBatch", threshold: 10 },
        { kind: "interval", intervalMs: 7200000 },
      ],
      context: ["vision", "roadmap", "taskSummary"],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers).toHaveLength(3);
      expect(result.data.context).toHaveLength(3);
    }
  });

  it("rejects murmur config with no triggers", () => {
    const config = {
      triggers: [],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects murmur config with invalid trigger kind", () => {
    const config = {
      triggers: [{ kind: "invalidKind" }],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("allows murmur config without context", () => {
    const config = {
      triggers: [{ kind: "queueEmpty" }],
    };

    const result = MurmurConfig.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context).toBeUndefined();
    }
  });
});

describe("OrgTeam - murmur integration", () => {
  it("parses team with murmur config", () => {
    const team = {
      id: "swe",
      name: "Software Engineering",
      orchestrator: "swe-pm",
      technicalLead: "swe-architect",
      murmur: {
        triggers: [
          { kind: "queueEmpty" },
          { kind: "completionBatch", threshold: 5 },
        ],
        context: ["vision", "roadmap"],
      },
    };

    const result = OrgTeam.safeParse(team);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.murmur).toBeDefined();
      expect(result.data.murmur?.triggers).toHaveLength(2);
    }
  });

  it("allows team without murmur config (backward compatibility)", () => {
    const team = {
      id: "swe",
      name: "Software Engineering",
      orchestrator: "swe-pm",
    };

    const result = OrgTeam.safeParse(team);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.murmur).toBeUndefined();
    }
  });

  it("rejects team with invalid murmur config", () => {
    const team = {
      id: "swe",
      name: "Software Engineering",
      murmur: {
        triggers: [], // Empty triggers array should fail
      },
    };

    const result = OrgTeam.safeParse(team);
    expect(result.success).toBe(false);
  });
});

describe("validateTeamAgents", () => {
  it("validates team with valid orchestrator", () => {
    const chart: OrgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-pm", name: "PM" },
        { id: "swe-architect", name: "Architect" },
      ],
      teams: [
        {
          id: "swe",
          name: "Software Engineering",
          orchestrator: "swe-pm",
        },
      ],
    };

    const errors = validateTeamAgents(chart);
    expect(errors).toHaveLength(0);
  });

  it("validates team with valid orchestrator and technicalLead", () => {
    const chart: OrgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-pm", name: "PM" },
        { id: "swe-architect", name: "Architect" },
      ],
      teams: [
        {
          id: "swe",
          name: "Software Engineering",
          orchestrator: "swe-pm",
          technicalLead: "swe-architect",
        },
      ],
    };

    const errors = validateTeamAgents(chart);
    expect(errors).toHaveLength(0);
  });

  it("reports error when orchestrator references undefined agent", () => {
    const chart: OrgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-pm", name: "PM" },
      ],
      teams: [
        {
          id: "swe",
          name: "Software Engineering",
          orchestrator: "undefined-agent",
        },
      ],
    };

    const errors = validateTeamAgents(chart);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("swe");
    expect(errors[0]).toContain("orchestrator");
    expect(errors[0]).toContain("undefined-agent");
  });

  it("reports error when technicalLead references undefined agent", () => {
    const chart: OrgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-pm", name: "PM" },
      ],
      teams: [
        {
          id: "swe",
          name: "Software Engineering",
          technicalLead: "undefined-architect",
        },
      ],
    };

    const errors = validateTeamAgents(chart);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("swe");
    expect(errors[0]).toContain("technicalLead");
    expect(errors[0]).toContain("undefined-architect");
  });

  it("reports multiple errors for multiple invalid teams", () => {
    const chart: OrgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-pm", name: "PM" },
      ],
      teams: [
        {
          id: "swe",
          name: "Software Engineering",
          orchestrator: "undefined-pm",
          technicalLead: "undefined-architect",
        },
        {
          id: "data",
          name: "Data Team",
          orchestrator: "undefined-data-pm",
        },
      ],
    };

    const errors = validateTeamAgents(chart);
    expect(errors).toHaveLength(3);
  });

  it("allows teams without orchestrator or technicalLead", () => {
    const chart: OrgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-pm", name: "PM" },
      ],
      teams: [
        {
          id: "swe",
          name: "Software Engineering",
        },
      ],
    };

    const errors = validateTeamAgents(chart);
    expect(errors).toHaveLength(0);
  });
});
