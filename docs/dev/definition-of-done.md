# Definition of Done — SWE Team

**Purpose:** Prevent incomplete work from being marked "done" and causing production failures.

## Standard "Done" Criteria (All Tasks)

1. **Source compiles cleanly** (`npm run build` or equivalent)
2. **All tests pass** (unit + integration + e2e where applicable)
3. **Code reviewed** (if applicable)
4. **Documentation updated** (if behavior changed)
5. **Task card updated** with completion summary

## "Done" for Deployment Artifacts (Plugins, Services, Infrastructure)

Deployment artifacts (plugins, services, integrations with external systems) have **stricter requirements** because operator intervention should be minimal and failure risk is high.

### 1. Source Compiles Cleanly
- `npm run build` (or equivalent) exits 0
- `tsc --noEmit` passes (no type errors)
- No warnings that indicate correctness issues

### 2. Deploy Script Exists
- A script or documented procedure exists to produce a **ready-to-install artifact**
- The script is **tested** (not just written)
- The artifact can be deployed by **following simple instructions** (no debugging required)
- Example: `npm run deploy:plugin` → copies files to target directory → artifact loads without errors

### 3. Integration Tests Against REAL API
- Tests validate against the **actual target system** (not mocks with assumed signatures)
- For OpenClaw plugins: tests run against **real OpenClaw extensionAPI.js** (containerized or local)
- For AWS/external APIs: tests use staging/sandbox environments or validated stubs
- **Hand-rolled mocks are NOT sufficient** for deployment validation

### 4. QA Sign-Off in Test Environment
- QA has **run the artifact** in a test/staging environment
- QA confirms:
  - Artifact loads without errors
  - Core functionality works (smoke tests pass)
  - No regressions in existing features
- **Containerized test environments are required** when production is high-risk

### 5. Deploy Instructions Are Simple and Tested
- A non-SWE coordinator (ops role) can follow the instructions without debugging
- Instructions are **tested** (not theoretical)
- Rollback procedure exists and is documented

---

## Anti-Patterns (What "Done" Is NOT)

❌ **"The code is written"** — but not compiled, tested, or deployed  
❌ **"Tests pass"** — but tests use mocks that don't match the real API  
❌ **"Integration plan exists"** — but it's a theory document with no executable validation  
❌ **"Deployed to production"** — but crashed the gateway because no staging validation happened  
❌ **"I tested it locally"** — but artifact was hand-compiled and not reproducible  

---

## Enforcement

- **Specialists**: Do not mark tasks "done" or move to `review/` until all criteria met
- **Architect**: Do not move tasks from `review/` to `done/` without verifying criteria
- **QA**: Reject any deployment artifact that doesn't meet criteria 3-5

---

## Example: OpenClaw Plugin Deployment Checklist

- [ ] `src/plugin.ts` exists and compiles to `dist/plugin.js`
- [ ] `openclaw.plugin.json` exists in source
- [ ] `npm run build` exits cleanly
- [ ] Deploy script exists (`npm run deploy:plugin` or `scripts/deploy-plugin.sh`)
- [ ] Deploy script tested: artifact installs and OpenClaw loads it without errors
- [ ] Integration tests run against **containerized OpenClaw** (not mocks)
- [ ] QA has validated plugin in container: tools register, service starts, no crashes
- [ ] Rollback tested: removing plugin entry from `openclaw.json` restores previous state

---

**This standard applies immediately.** Any task currently in `review/` or `done/` that doesn't meet these criteria should be reopened.
