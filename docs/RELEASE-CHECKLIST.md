# AOF Release Checklist

Step-by-step process for cutting a public AOF release to npm.

---

## Pre-Release Verification

### 1. Sync and verify clean state
```bash
git checkout main
git pull origin main
git status  # should be clean
```

### 2. Run the full test suite
```bash
npm run test         # unit + integration (2,195+ tests)
npm run test:e2e     # end-to-end tests
```
Both must pass with zero failures before proceeding.

### 3. Run type-check
```bash
npm run typecheck    # tsc --noEmit — must produce zero errors
```

### 4. Verify the build is clean
```bash
rm -rf dist/
npm run build        # tsc + copy-extension-entry.js
```
Build must complete with no errors. Verify `dist/` is populated.

### 5. Verify CLI entry point
```bash
node dist/cli/index.js --version   # should print current version
node dist/daemon/index.js --help   # should print daemon help
```

---

## Version Bump

### 6. Update version in package.json
```bash
# For a patch release:
npm version patch --no-git-tag-version

# For a minor release:
npm version minor --no-git-tag-version

# For a major release:
npm version major --no-git-tag-version
```

### 7. Sync version to openclaw.plugin.json
```bash
# Set the version field to match package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const plugin = JSON.parse(fs.readFileSync('openclaw.plugin.json','utf8'));
plugin.version = pkg.version;
fs.writeFileSync('openclaw.plugin.json', JSON.stringify(plugin, null, 2) + '\n');
console.log('openclaw.plugin.json updated to', pkg.version);
"
```

### 8. Commit version bump
```bash
git add package.json package-lock.json openclaw.plugin.json
git commit -m "chore: release v$(node -p 'require(\"./package.json\").version')"
```

---

## Package Verification

### 9. Run npm pack dry-run
```bash
npm pack --dry-run
```
Verify the output includes:
- `dist/` — all compiled JS, d.ts, and map files
- `prompts/` — agent guides and context
- `index.ts` — OpenClaw plugin entry
- `openclaw.plugin.json` — OpenClaw plugin manifest
- `README.md` — package documentation
- `package.json`

Must NOT include: `src/`, `tests/`, `docs/`, `mailbox/`, `tasks/`, `scripts/`, `.beads/`, `.learnings/`

Update `docs/internal/PACK-MANIFEST.txt`:
```bash
npm pack --dry-run 2>&1 | grep "npm notice" > docs/internal/PACK-MANIFEST.txt
git add docs/internal/PACK-MANIFEST.txt
git commit -m "chore: update pack manifest for release"
```

### 10. Verify exports work
```bash
node -e "import('./dist/index.js').then(m => console.log('Exports OK:', Object.keys(m).length, 'symbols'))"
node -e "import('./dist/plugin.js').then(m => console.log('Plugin OK, default type:', typeof m.default))"
```

---

## Publish

### 11. Tag the release
```bash
VERSION=$(node -p 'require("./package.json").version')
git tag "v${VERSION}"
git push origin main --tags
```

### 12. Publish to npm
```bash
# Dry run first
npm publish --dry-run

# Actual publish
npm publish --access public
```

> **Note:** Do NOT run `npm publish` until CI passes on the version bump commit.

---

## Post-Release

### 13. Verify installation
```bash
# In a temp directory
mkdir /tmp/aof-install-test && cd /tmp/aof-install-test
npm init -y
npm install aof
node -e "import('aof').then(m => console.log('Install OK'))"
```

### 14. Test CLI via npx
```bash
npx aof --version
```

### 15. Create GitHub release
- Go to https://github.com/demerzel-ops/aof/releases/new
- Tag: `v{version}`
- Title: `AOF v{version}`
- Body: Copy from CHANGELOG or summarize key changes

---

## Notes

- **Peer dependency**: `openclaw >=2026.2.0` is marked optional — AOF can be used as a standalone CLI and library without OpenClaw
- **Plugin loading**: OpenClaw uses `openclaw.plugin.json`'s `main` field (`dist/plugin.js`) for plugin loading — not `package.json` `main`
- **Library consumers**: `import 'aof'` resolves to `dist/index.js` (full library barrel) via the `exports` map
- **Repository move**: When repo moves to `Seldon-Engine/aof`, update `repository.url` in `package.json`
