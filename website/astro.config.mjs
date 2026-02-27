import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://seldon-engine.github.io",
  base: "/aof",
  integrations: [
    starlight({
      title: "AOF — Agentic Ops Fabric",
      description:
        "Deterministic orchestration for multi-agent systems. AOF turns an agent swarm into a reliable, observable, restart-safe operating environment.",
      favicon: "/favicon.ico",
      social: {
        github: "https://github.com/Seldon-Engine/aof",
      },
      editLink: {
        baseUrl: "https://github.com/Seldon-Engine/aof/edit/main/docs/",
      },
      lastUpdated: true,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "What is AOF?", link: "/getting-started/overview" },
            { label: "Installation & Setup", link: "/getting-started/installation" },
            { label: "Quick Start Tutorial", link: "/getting-started/quick-start" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Org Charts", link: "/guide/org-charts" },
            { label: "Task Lifecycle", link: "/guide/task-lifecycle" },
            { label: "Workflow Gates", link: "/guide/workflow-gates" },
            { label: "Tiered Memory", link: "/guide/memory" },
            { label: "Protocols", link: "/guide/protocols" },
            { label: "Notifications", link: "/guide/notifications" },
            { label: "Cascading Deps", link: "/guide/cascading-dependencies" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI Commands", link: "/guide/cli-reference" },
            { label: "Agent Tools", link: "/guide/agent-tools" },
            { label: "Task Format", link: "/guide/task-format" },
            { label: "Configuration", link: "/guide/configuration" },
            { label: "SLA", link: "/guide/sla" },
            { label: "Event Logs", link: "/guide/event-logs" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Getting Started", link: "/guide/getting-started" },
            { label: "Deployment", link: "/guide/deployment" },
            { label: "Custom Gates", link: "/guide/custom-gates" },
            { label: "Migration", link: "/guide/migration" },
            { label: "Recovery", link: "/guide/recovery" },
            { label: "Known Issues", link: "/guide/known-issues" },
          ],
        },
        {
          label: "Contributing",
          items: [
            { label: "Architecture", link: "/dev/architecture" },
            { label: "Dev Workflow", link: "/dev/dev-workflow" },
            { label: "Engineering Standards", link: "/dev/engineering-standards" },
            { label: "Release Checklist", link: "/dev/release-checklist" },
          ],
        },
      ],
    }),
  ],
});
