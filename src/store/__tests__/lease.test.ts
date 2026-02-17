import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";
import { acquireLease, renewLease, releaseLease, expireLeases } from "../lease.js";

describe("Lease management", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-lease-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("acquires a lease on a ready task", async () => {
    const task = await store.create({ title: "Lease test", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    const leased = await acquireLease(store, task.frontmatter.id, "swe-backend");

    expect(leased.frontmatter.status).toBe("in-progress");
    expect(leased.frontmatter.lease).toBeDefined();
    expect(leased.frontmatter.lease!.agent).toBe("swe-backend");
    expect(leased.frontmatter.lease!.renewCount).toBe(0);
  });

  it("prevents lease acquisition by another agent", async () => {
    const task = await store.create({ title: "Contested", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    await acquireLease(store, task.frontmatter.id, "swe-backend", { ttlMs: 60_000 });

    await expect(
      acquireLease(store, task.frontmatter.id, "swe-frontend"),
    ).rejects.toThrow("is leased to swe-backend");
  });

  it("allows same agent to re-acquire", async () => {
    const task = await store.create({ title: "Re-acquire", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    await acquireLease(store, task.frontmatter.id, "swe-backend");

    // Same agent can re-acquire (idempotent)
    const reacquired = await acquireLease(store, task.frontmatter.id, "swe-backend");
    expect(reacquired.frontmatter.lease!.agent).toBe("swe-backend");
  });

  it("renews a lease", async () => {
    const task = await store.create({ title: "Renew test", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    const leased = await acquireLease(store, task.frontmatter.id, "swe-backend");
    const originalExpiry = leased.frontmatter.lease!.expiresAt;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const renewed = await renewLease(store, task.frontmatter.id, "swe-backend");

    expect(renewed.frontmatter.lease!.renewCount).toBe(1);
    expect(renewed.frontmatter.lease!.expiresAt).not.toBe(originalExpiry);
  });

  it("rejects renewal by wrong agent", async () => {
    const task = await store.create({ title: "Wrong agent", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    await acquireLease(store, task.frontmatter.id, "swe-backend");

    await expect(
      renewLease(store, task.frontmatter.id, "swe-frontend"),
    ).rejects.toThrow("not swe-frontend");
  });

  it("rejects renewal past max renewals", async () => {
    const task = await store.create({ title: "Max renewals", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    await acquireLease(store, task.frontmatter.id, "swe-backend");

    await renewLease(store, task.frontmatter.id, "swe-backend", { maxRenewals: 2 });
    await renewLease(store, task.frontmatter.id, "swe-backend", { maxRenewals: 2 });

    await expect(
      renewLease(store, task.frontmatter.id, "swe-backend", { maxRenewals: 2 }),
    ).rejects.toThrow("exhausted lease renewals");
  });

  it("releases a lease", async () => {
    const task = await store.create({ title: "Release test", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    await acquireLease(store, task.frontmatter.id, "swe-backend");

    const released = await releaseLease(store, task.frontmatter.id, "swe-backend");
    expect(released.frontmatter.status).toBe("ready");
    expect(released.frontmatter.lease).toBeUndefined();
  });

  it("expires stale leases", async () => {
    const task = await store.create({ title: "Expire test", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");

    // Acquire with 1ms TTL (immediately expires)
    await acquireLease(store, task.frontmatter.id, "swe-backend", { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));

    const expired = await expireLeases(store);
    expect(expired).toContain(task.frontmatter.id);

    // Task should be back to ready
    const reloaded = await store.get(task.frontmatter.id);
    expect(reloaded!.frontmatter.status).toBe("ready");
    expect(reloaded!.frontmatter.lease).toBeUndefined();
  });
});
