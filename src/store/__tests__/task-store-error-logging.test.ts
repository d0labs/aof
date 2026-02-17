/**
 * BUG-001 Additional Tests: Parse error visibility
 * 
 * Ensures malformed task files are reported via lint(), not silently skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";

describe("BUG-001: Parse error visibility", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-parse-errors-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("lint() reports files with schema validation errors", async () => {
    const backlogDir = join(tmpDir, "tasks", "backlog");
    
    // Write file with invalid schema (matches the audit test file)
    const invalidFile = join(backlogDir, "test-invalid.md");
    await writeFile(invalidFile, `---
id: test-bug001-smoke
title: Invalid Task
status: backlog
priority: p0
assignee: swe-cloud
created: 2026-02-08T19:23:00Z
updated: 2026-02-08T19:23:00Z
---

Test body
`);

    // lint() should identify the parse error
    const issues = await store.lint();
    expect(issues.length).toBeGreaterThan(0);
    
    const parseError = issues.find(i => 
      i.task.path === invalidFile && i.issue.includes("Parse error")
    );
    expect(parseError).toBeDefined();
    expect(parseError?.issue).toContain("Parse error");
  });

  it("lint() reports files with missing required fields", async () => {
    const readyDir = join(tmpDir, "tasks", "ready");
    await mkdir(readyDir, { recursive: true });
    
    const invalidFile = join(readyDir, "missing-fields.md");
    await writeFile(invalidFile, `---
title: Incomplete Task
status: ready
---

Missing all required fields
`);

    const issues = await store.lint();
    const parseErrors = issues.filter(i => i.issue.includes("Parse error"));
    expect(parseErrors.length).toBeGreaterThan(0);
  });

  it("list() skips invalid files but lint() reports them", async () => {
    const backlogDir = join(tmpDir, "tasks", "backlog");
    
    // Invalid file
    await writeFile(join(backlogDir, "invalid.md"), `---
title: Invalid
---
Body`);
    
    // Valid file (proper schema)
    await writeFile(join(backlogDir, "TASK-2026-02-08-001.md"), `---
schemaVersion: 1
id: TASK-2026-02-08-001
project: AOF
title: Valid Task
status: backlog
priority: normal
routing:
  tags: []
createdAt: "2026-02-08T19:00:00Z"
updatedAt: "2026-02-08T19:00:00Z"
lastTransitionAt: "2026-02-08T19:00:00Z"
createdBy: system
dependsOn: []
metadata: {}
contentHash: abc
---

Valid body
`);

    // list() should return only the valid task
    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.frontmatter.id).toBe("TASK-2026-02-08-001");

    // lint() should report the invalid file
    const issues = await store.lint();
    const invalidFileIssue = issues.find(i => i.task.path?.includes("invalid.md"));
    expect(invalidFileIssue).toBeDefined();
  });
});
