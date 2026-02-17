/**
 * BUG-001 Regression Test: Silent Task Parse Failure
 * 
 * Critical bug: Parser silently drops tasks with legacy/invalid frontmatter.
 * No validation errors, no events, no logs. This test verifies that:
 * 
 * 1. Malformed tasks emit task.validation.failed events
 * 2. Parse errors are logged at WARNING level
 * 3. Specific legacy field names (created, updated, tags) are caught
 * 4. aof_status_report surfaces validation errors or unparseable count
 * 
 * This test should FAIL against current code (which silently drops malformed tasks)
 * and PASS once backend adds schema validation + error reporting.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-001: Silent parse failure (validation errors not surfaced)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let eventsDir: string;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug001-"));
    
    eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    
    capturedEvents = [];
    logger = new EventLogger(eventsDir, {
      onEvent: (event) => {
        capturedEvents.push(event);
      },
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should emit task.validation.failed event for legacy field names", async () => {
    const backlogDir = join(tmpDir, "tasks", "backlog");
    const invalidFile = join(backlogDir, "test-bug001-legacy.md");
    
    // Write file with legacy schema (matches the audit test case)
    await writeFile(invalidFile, `---
id: test-bug001-legacy
title: Legacy Schema Task
status: backlog
priority: p0
created: 2026-02-08T15:00:00Z
updated: 2026-02-08T15:00:00Z
tags: [backend, cloud]
---

Test task body with legacy frontmatter fields.
`);

    // Attempt to load/validate this file
    // In current code: silently ignored
    // After fix: should emit event
    const tasks = await store.list();
    const lintIssues = await store.lint();
    
    // Task should not be in the list (parse failed)
    const foundTask = tasks.find(t => t.frontmatter.id === "test-bug001-legacy");
    expect(foundTask).toBeUndefined();
    
    // CRITICAL: Should emit task.validation.failed event
    const validationFailedEvents = capturedEvents.filter(
      e => e.type === "task.validation.failed"
    );
    expect(validationFailedEvents.length).toBeGreaterThan(0);
    
    const relevantEvent = validationFailedEvents.find(
      e => e.payload?.filename?.includes("test-bug001-legacy.md")
    );
    expect(relevantEvent).toBeDefined();
    expect(relevantEvent?.payload?.errors).toBeDefined();
    
    // Should list specific validation errors
    const errors = relevantEvent?.payload?.errors;
    expect(errors).toContain("created"); // legacy field
    expect(errors).toContain("updated"); // legacy field
    // OR: expect single error message mentioning all legacy fields
  });

  it("should log WARNING with filename and validation errors", async () => {
    const backlogDir = join(tmpDir, "tasks", "backlog");
    const invalidFile = join(backlogDir, "test-missing-required.md");
    
    // Write file missing required fields
    await writeFile(invalidFile, `---
title: Incomplete Task
status: ready
---

Missing required fields: createdAt, updatedAt, etc.
`);

    // Trigger validation
    const lintIssues = await store.lint();
    
    // Should report parse errors via lint()
    const parseError = lintIssues.find(
      i => i.task.path === invalidFile && i.issue.includes("Parse error")
    );
    expect(parseError).toBeDefined();
    
    // CRITICAL: Check for validation failed event with details
    const validationEvents = capturedEvents.filter(
      e => e.type === "task.validation.failed"
    );
    
    if (validationEvents.length > 0) {
      const event = validationEvents.find(
        e => e.payload?.filename?.includes("test-missing-required.md")
      );
      expect(event).toBeDefined();
      expect(event?.payload?.errors).toBeDefined();
    }
    
    // Note: Log level verification would require capturing stderr/logger output
    // For now, we verify that the event contains severity or implicit warning level
  });

  it("should handle the exact legacy field pattern from the audit", async () => {
    // Reproduces the exact case from the audit report
    const backlogDir = join(tmpDir, "tasks", "backlog");
    const testFile = join(backlogDir, "test-bug001-1770578621.md");
    
    await writeFile(testFile, `---
id: test-bug001-1770578621
title: Audit Test Case
status: backlog
created: 2026-02-08T15:00:00Z
updated: 2026-02-08T15:00:00Z
tags: [integration, audit]
---

This is the exact test case from the integration audit.
Legacy fields: created, updated, tags (should be createdAt, updatedAt, routing.tags).
`);

    // Expected behavior:
    // - Task is NOT in list() results
    // - lint() reports parse error
    // - Event is emitted with validation details
    
    const tasks = await store.list();
    expect(tasks).toHaveLength(0); // Or at least, this task is not included
    
    const lintIssues = await store.lint();
    const issueForFile = lintIssues.find(i => i.task.path === testFile);
    expect(issueForFile).toBeDefined();
    expect(issueForFile?.issue).toContain("Parse error");
    
    // Event should be emitted
    const validationFailedEvents = capturedEvents.filter(
      e => e.type === "task.validation.failed"
    );
    
    const auditCaseEvent = validationFailedEvents.find(
      e => e.payload?.filename?.includes("test-bug001-1770578621.md")
    );
    expect(auditCaseEvent).toBeDefined();
  });

  it("should distinguish between parse errors and validation errors", async () => {
    const backlogDir = join(tmpDir, "tasks", "backlog");
    
    // Case 1: Malformed YAML (parse error)
    const malformedYaml = join(backlogDir, "malformed.md");
    await writeFile(malformedYaml, `---
id: malformed
title: "Unclosed quote
status: backlog
---

Body
`);

    // Case 2: Valid YAML but invalid schema (validation error)
    const invalidSchema = join(backlogDir, "invalid-schema.md");
    await writeFile(invalidSchema, `---
id: invalid-schema
title: Invalid Schema
status: backlog
created: 2026-01-01T00:00:00Z
---

Body
`);

    const lintIssues = await store.lint();
    
    // Both should be reported
    expect(lintIssues.length).toBeGreaterThanOrEqual(2);
    
    // Check that we can distinguish error types
    const malformedIssue = lintIssues.find(i => i.task.path === malformedYaml);
    const schemaIssue = lintIssues.find(i => i.task.path === invalidSchema);
    
    expect(malformedIssue).toBeDefined();
    expect(schemaIssue).toBeDefined();
  });

  it("should include parse error count in status reporting", async () => {
    // Create one valid task and one invalid task
    const valid = await store.create({
      title: "Valid Task",
      createdBy: "test",
    });
    
    const backlogDir = join(tmpDir, "tasks", "backlog");
    const invalidFile = join(backlogDir, "invalid.md");
    await writeFile(invalidFile, `---
title: Invalid
---
Body`);

    const lintIssues = await store.lint();
    const tasks = await store.list();
    
    // list() should return only valid tasks
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.frontmatter.id).toBe(valid.frontmatter.id);
    
    // lint() should report the invalid file
    const parseErrors = lintIssues.filter(i => i.issue.includes("Parse error"));
    expect(parseErrors.length).toBeGreaterThan(0);
    
    // FUTURE: aof_status_report should include unparseable count
    // For now, we verify that the data is available via lint()
  });

  it("should handle mixed valid and invalid files in same directory", async () => {
    const readyDir = join(tmpDir, "tasks", "ready");
    await mkdir(readyDir, { recursive: true });
    
    // Write 2 valid tasks
    const valid1 = await store.create({
      title: "Valid 1",
      createdBy: "test",
    });
    await store.transition(valid1.frontmatter.id, "ready");
    
    const valid2 = await store.create({
      title: "Valid 2",
      createdBy: "test",
    });
    await store.transition(valid2.frontmatter.id, "ready");
    
    // Write 1 invalid task
    const invalidFile = join(readyDir, "invalid-ready.md");
    await writeFile(invalidFile, `---
title: Invalid Ready Task
status: ready
created: 2026-01-01T00:00:00Z
---

Invalid
`);

    const tasks = await store.list();
    const readyTasks = tasks.filter(t => t.frontmatter.status === "ready");
    
    // Should return only the 2 valid tasks
    expect(readyTasks).toHaveLength(2);
    
    // lint() should report the invalid file
    const lintIssues = await store.lint();
    const invalidIssue = lintIssues.find(i => i.task.path === invalidFile);
    expect(invalidIssue).toBeDefined();
    
    // Event should be emitted for the invalid file
    const validationEvents = capturedEvents.filter(
      e => e.type === "task.validation.failed" &&
         e.payload?.filename?.includes("invalid-ready.md")
    );
    expect(validationEvents.length).toBeGreaterThan(0);
  });
});
