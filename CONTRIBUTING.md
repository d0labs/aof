# Contributing to AOF

Thank you for your interest in contributing to AOF! This document covers development setup, coding standards, and the pull request process.

---

## Table of Contents

1. [Development Setup](#development-setup)
2. [Project Structure](#project-structure)
3. [Development Workflow](#development-workflow)
4. [Coding Standards](#coding-standards)
5. [Testing](#testing)
6. [Submitting a Pull Request](#submitting-a-pull-request)
7. [Releasing](#releasing)
8. [Reporting Issues](#reporting-issues)

---

## Development Setup

### Prerequisites

- Node.js 22+
- npm 9+
- Git

### Clone and install

```bash
git clone https://github.com/d0labs/aof.git
cd aof
npm install
npm run build
```

### Verify your setup

```bash
npm test
```

All tests should pass. If any fail on a clean clone, please [open an issue](#reporting-issues).

---

## Project Structure

```
src/
├── cli/          CLI commands (Commander.js)
├── daemon/       Background service
├── dispatch/     Scheduler, gate evaluator, SLA checker, lease manager, dep-cascader
├── store/        Filesystem task store
├── protocol/     Inter-agent protocol router
├── events/       Event logger + notification engine
├── memory/       Memory medallion pipeline + HNSW vector index
├── metrics/      Prometheus exporter
├── org/          Org-chart parser and validator
├── schemas/      Zod schemas (source of truth for all data shapes)
├── views/        Kanban and mailbox view generators
└── recovery/     Task resurrection and deadletter handling

tests/            Integration and e2e tests (separate from src/__tests__)
docs/             Documentation
```

---

## Development Workflow

AOF uses **trunk-based development** on `main`. Keep changes small and focused.

### Fast iteration loop

```bash
# Run targeted tests (fastest feedback)
npx vitest run src/dispatch

# Watch mode during active development
npx vitest src/dispatch --watch

# Full suite before opening a PR
npm test
```

### TypeScript

```bash
# Type-check without building
npx tsc --noEmit

# Build
npm run build
```

### Commit style

Use conventional commits with a short prefix:

```
feat: add cascade-on-block for dependency propagation
fix: handle missing lease on task transition
test: add scheduler poll cycle integration tests
docs: update workflow gates reference
refactor: extract gate-context-builder from scheduler
```

---

## Coding Standards

- **TypeScript strict mode** — no `any`, no implicit returns on functions with return types
- **Zod schemas** are the source of truth for all data shapes — add/change schemas before implementation
- **Pure functions preferred** — side effects at the edges (store reads/writes, logging)
- **No LLM calls in the control plane** — scheduler, gate evaluator, and store must be deterministic
- **Every behavior change gets a test** — TDD preferred; no PR without corresponding test coverage
- **File size** — if a module exceeds ~300 lines, consider splitting it; avoid "god files"

### Key architectural constraints

1. State transitions must go through `store.transition()` — do not write task files directly
2. The scheduler must remain free of I/O side effects beyond the task store and event logger
3. Protocol messages must be validated against Zod schemas before processing
4. All filesystem operations on tasks must be atomic (the store handles this)

### Further reading

- [Development Workflow](docs/dev/dev-workflow.md) -- Fast-feedback development loop
- [Engineering Standards](docs/dev/engineering-standards.md) -- Code quality and module structure rules
- [Architecture Overview](docs/dev/architecture.md) -- System architecture for contributors
- [Definition of Done](docs/dev/definition-of-done.md) -- What "complete" means for AOF tasks

---

## Testing

AOF has three test layers:

| Layer | Location | Runner |
|---|---|---|
| Unit tests | `src/**/__tests__/` | `npx vitest run` |
| Integration tests | `tests/integration/` | `npm test` |
| E2E tests | `tests/e2e/` | `npm run test:e2e` |

### Running tests

```bash
# Full suite
npm test

# Unit only
npx vitest run src

# Specific module
npx vitest run src/dispatch

# Single file
npx vitest run src/dispatch/__tests__/scheduler.test.ts

# Watch mode
npx vitest src/dispatch --watch
```

### Test conventions

- Unit tests live alongside source files in `__tests__/` subdirectories
- Use `vi.mock()` for filesystem and external service mocks
- Integration tests use a real (temporary) filesystem via `tmp-fixture` helpers
- Do not write tests that depend on global state or test ordering

---

## Submitting a Pull Request

1. **Fork** the repository and create a branch from `main`
2. **Write tests** for your change (unit + integration where applicable)
3. **Run the full suite**: `npm test` — must be green
4. **Type-check**: `npx tsc --noEmit` — must be clean
5. **Update docs** if you changed behavior, CLI flags, or schemas
6. **Open a PR** with a clear title and description:
   - What problem does this solve?
   - What approach did you take?
   - Any tradeoffs or known limitations?

### PR checklist

- [ ] Tests added or updated
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` clean
- [ ] Docs updated (if applicable)
- [ ] Commit messages are descriptive

---

## Releasing

AOF uses tagged releases. CI builds the tarball and publishes the GitHub release automatically.

### How it works

1. Create a version tag on `main`:
   ```bash
   git tag -a v1.2.0 -m "AOF v1.2.0"
   ```
2. Push the tag:
   ```bash
   git push origin main --tags
   ```
3. The [release workflow](.github/workflows/release.yml) triggers on `v*` tags and:
   - Runs typecheck, build, and tests
   - Generates a changelog from conventional commits since the previous tag
   - Builds a release tarball via `scripts/build-tarball.mjs` (strips dev-only fields like `prepare` and `simple-git-hooks` from `package.json`)
   - Creates a GitHub release with the changelog and tarball attached

### Version scheme

- **Patch** (`v1.1.1`): bug fixes, CI changes, doc fixes
- **Minor** (`v1.2.0`): new features, non-breaking changes
- **Major** (`v2.0.0`): breaking changes to CLI, config schema, or plugin API

### Alternative: release-it

You can also use `release-it` to automate version bumping, tagging, and changelog generation in one step:

```bash
npm run release:patch   # or release:minor, release:major
```

This requires a `GITHUB_TOKEN` (sourced automatically from `gh auth token`).

---

## Reporting Issues

Use GitHub Issues. Please include:

- AOF version (`node dist/cli/index.js --version`)
- Node.js version (`node --version`)
- OS and architecture
- Minimal reproduction steps
- Expected vs. actual behavior
- Relevant logs (from `events/events.jsonl` or daemon output)
