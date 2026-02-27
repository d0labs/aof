# AOF Dev Tooling Guide

A guide to AOF's release automation, commit conventions, and git hooks.  
Designed as a reusable pattern — see [Extracting as a Template](#extracting-as-a-template) at the bottom.

---

## Overview

| Concern | Tool | Config |
|---------|------|--------|
| Commit message linting | `@commitlint/cli` | `.commitlintrc.json` |
| Git hooks management | `simple-git-hooks` | `package.json → simple-git-hooks` |
| Release automation | `release-it` | `.release-it.json` |
| Changelog / release notes | `@release-it/conventional-changelog` | inside `.release-it.json` |

---

## Conventional Commits

All commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<optional scope>): <short description>

<optional body>

<optional footer: BREAKING CHANGE: ...>
```

### Commit Types → Semver Mapping

| Commit type | Version bump |
|-------------|-------------|
| `BREAKING CHANGE:` in footer (any type) | **major** |
| `feat` | **minor** |
| `fix`, `perf`, `refactor` | **patch** |
| `chore`, `docs`, `test`, `ci` | no version bump |

### Examples

```bash
# Patch bump
git commit -m "fix(scheduler): handle null lease gracefully"

# Minor bump
git commit -m "feat(memory): add hybrid BM25+vector search"

# Major bump (breaking change)
git commit -m "feat(api): redesign task schema

BREAKING CHANGE: task.id is now a UUID instead of a short hash"
```

---

## Git Hooks

The `commit-msg` hook automatically validates every commit message:

```bash
# Installed via:
npm install   # triggers `prepare` → `npx simple-git-hooks`

# To manually re-install hooks:
npx simple-git-hooks
```

**Bypassing (for emergency use only):**
```bash
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "emergency commit"
```

---

## Cutting a Release

### Quick release (interactive)

```bash
npm run release
```

`release-it` will:
1. Run `npm run typecheck` and `npm test` (pre-flight checks)
2. Analyze commits since the last tag
3. Determine the semver bump (patch/minor/major) automatically
4. Show a changelog preview and ask for confirmation
5. Commit the version bump, create an annotated tag, push to origin
6. Create a GitHub Release with generated release notes

### Explicit version bump

```bash
npm run release:patch   # x.y.Z — bug fixes
npm run release:minor   # x.Y.0 — new features
npm run release:major   # X.0.0 — breaking changes
```

### Dry run (no changes made)

```bash
npm run release:dry
```

### Skip pre-flight checks (CI/emergency)

```bash
GITHUB_TOKEN=$(gh auth token) npx release-it --no-hooks --ci
```

---

## Configuration Reference

### `.commitlintrc.json`

```json
{
  "extends": ["@commitlint/config-conventional"],
  "rules": {
    "subject-case": [1, "never", ["pascal-case", "upper-case"]],
    "body-max-line-length": [1, "always", 200],
    "footer-max-line-length": [1, "always", 200]
  }
}
```

- Rules at level `1` = **warnings** (not hard failures)
- Level `2` = hard failures. Tighten as needed.

### `.release-it.json`

```json
{
  "git": {
    "commitMessage": "chore: release v${version}",
    "tagName": "v${version}",
    "requireCleanWorkingDir": true
  },
  "github": { "release": true },
  "npm": { "publish": false },
  "plugins": {
    "@release-it/conventional-changelog": {
      "preset": { "name": "conventionalcommits" },
      "infile": false
    }
  },
  "hooks": {
    "before:init": ["npm run typecheck", "npm test"]
  }
}
```

Key decisions:
- `infile: false` — no `CHANGELOG.md` file is written; notes go only to GitHub Releases
- `npm.publish: false` — opt back in by setting to `true` when ready for npm
- `GITHUB_TOKEN` is sourced via `$(gh auth token)` in the npm script (no .env file needed)

---

## Initial Tag Setup (First-Time Project Setup)

When adopting this tooling on a new project with no tags:

```bash
# Tag the current HEAD as the initial release
git tag -a v0.1.0 -m "chore: initial release v0.1.0"
git push origin v0.1.0

# Create the GitHub release for that tag
gh release create v0.1.0 \
  --title "v0.1.0 — Initial Release" \
  --notes "Initial release. Future releases are generated automatically."
```

All subsequent releases use `npm run release`.

---

## Extracting as a Template

This setup is intentionally generic. To replicate it in any Node.js project:

### 1. Install dependencies

```bash
npm install --save-dev \
  simple-git-hooks \
  @commitlint/cli \
  @commitlint/config-conventional \
  release-it \
  @release-it/conventional-changelog
```

### 2. Add to `package.json`

```json
{
  "scripts": {
    "prepare": "simple-git-hooks",
    "release": "GITHUB_TOKEN=$(gh auth token) release-it",
    "release:dry": "GITHUB_TOKEN=$(gh auth token) release-it --dry-run",
    "release:patch": "GITHUB_TOKEN=$(gh auth token) release-it patch",
    "release:minor": "GITHUB_TOKEN=$(gh auth token) release-it minor",
    "release:major": "GITHUB_TOKEN=$(gh auth token) release-it major"
  },
  "simple-git-hooks": {
    "commit-msg": "npx --no -- commitlint --edit $1"
  }
}
```

### 3. Copy config files

- `.commitlintrc.json` — commitlint config (copy as-is)
- `.release-it.json` — release-it config (adjust `npm.publish`, `before:init` hooks)

### 4. Activate hooks

```bash
npm install   # runs `prepare` → installs hooks
```

### 5. Create initial tag

```bash
git tag -a v0.1.0 -m "chore: initial release"
git push origin v0.1.0
```

### Tool Evaluation Notes

| Tool | Verdict |
|------|---------|
| `semantic-release` | Too opinionated; designed for CI pipelines, not local release flows |
| `standard-version` | Deprecated |
| `release-please` | Google-opinionated; tied to GitHub Actions; too heavy for local use |
| `changeset` | Designed for monorepos; requires manual per-PR changesets |
| **`release-it`** | ✅ Chosen — simple, configurable, works locally, GitHub-integrated |

`release-it` + `@release-it/conventional-changelog` is the sweet spot:
- ~150KB total, minimal transitive deps
- Local-first (no CI requirement)
- Interactive by default, `--ci` for non-interactive
- GitHub release creation built-in

---

*This pattern is suitable for extraction as an OpenClaw skill template.*
