# Migration Guide: Legacy → Projects v0

This guide explains how to migrate a legacy single-project AOF vault to the new Projects v0 layout.

## Overview

AOF now supports multi-project workflows through the Projects v0 layout. This migration tool helps you safely transition from the legacy single-project structure to the new multi-project structure.

### Layout Changes

**Legacy layout:**
```
<vault-root>/
  tasks/
    backlog/
    ready/
    ...
  events/
  views/
  state/
```

**Projects v0 layout:**
```
<vault-root>/
  Projects/
    _inbox/
      project.yaml
      tasks/
      artifacts/
      state/
      views/
      cold/
      events/  (if present in legacy)
  tasks.backup-<timestamp>/  (backup of legacy layout)
```

## Migration Command

```bash
aof migrate-to-projects [--dry-run]
```

### What it does

**For fresh installs (no legacy directories present):**
- Creates `Projects/_inbox/` with required structure and `project.yaml`
- Exits early (nothing to migrate)

**For existing vaults with legacy layout:**
1. **Creates backup**: Moves legacy directories (`tasks/`, `events/`, `views/`, `state/`) into a timestamped backup directory.
2. **Creates Projects/_inbox/**: Bootstraps the new project structure with all required directories.
3. **Migrates tasks**: Copies entire `tasks/` directory from backup into `Projects/_inbox/tasks/`, preserving all subdirectories, companion dirs, and non-markdown files.
4. **Updates frontmatter**: Adds `project: "_inbox"` to **top-level task cards only** (`tasks/<status>/*.md`). Companion directories, nested files, and non-markdown files are preserved unchanged.
5. **Migrates other data**: Copies `events/`, `views/`, `state/` if they existed.

### Options

- `--dry-run`: Report planned actions without making changes. Use this first to see what will happen.

### Example

```bash
# Preview the migration
aof migrate-to-projects --dry-run

# Perform the migration
aof migrate-to-projects
```

### Output

```
🔄 Migrating to Projects v0 layout...

✅ Migration complete!

   Backup: /path/to/vault/tasks.backup-2026-01-15T12-00-00-000Z
   Migrated directories: tasks, events, views, state
   Updated tasks: 42

💡 Next steps:
   1. Verify migrated tasks in Projects/_inbox/tasks/
   2. Test your workflows with the new layout
   3. If needed, rollback with: aof rollback-migration
```

**Note:** The "Updated tasks" count reflects only top-level task cards (`.md` files in status directories). Companion directories, nested files, and non-markdown files are preserved but not counted.

## Rollback Command

```bash
aof rollback-migration [--dry-run] [--backup <dir>]
```

### What it does

1. **Finds backup**: Uses the latest `tasks.backup-*` directory unless you specify one.
2. **Renames _inbox**: Moves `Projects/_inbox/` to `_inbox.rollback-<timestamp>` to avoid conflicts.
3. **Restores legacy layout**: Moves directories from backup back to vault root.

### Options

- `--dry-run`: Report planned actions without making changes.
- `--backup <dir>`: Specify an explicit backup directory to restore from (relative to vault root).

### Example

```bash
# Rollback using the latest backup
aof rollback-migration

# Rollback from a specific backup
aof rollback-migration --backup tasks.backup-2026-01-15T12-00-00-000Z

# Preview rollback
aof rollback-migration --dry-run
```

### Output

```
🔙 Rolling back migration...

✅ Rollback complete!

   Restored directories: tasks, events, views, state

⚠️  Warnings:
   • Renamed _inbox to _inbox.rollback-2026-01-15T14-30-00-000Z

💡 Next steps:
   1. Verify legacy tasks/ directory restored
   2. Resume normal operations with legacy layout
```

## Idempotency

- **Re-running migration** after success is safe. If legacy directories are already gone and `_inbox` exists, it reports "Already migrated" and does nothing.
- **Task frontmatter updates**: Only processes task cards that don't already have `project: "_inbox"` in their frontmatter (skips already-migrated tasks).

## Task Frontmatter

The migration adds `project: "_inbox"` to all task frontmatter. It does **not** validate the full schema, so legacy tasks with missing fields (e.g., old tasks without `createdAt`) will still migrate successfully.

## Hierarchical Projects (Optional)

Projects v0 now supports optional hierarchical organization via the `parentId` field in `project.yaml`. This is purely organizational and does not affect task inheritance or routing:

```yaml
# Projects/my-subproject/project.yaml
id: my-subproject
title: My Subproject
parentId: parent-project-id
...
```

**Key points:**
- `parentId` is optional and can be added to any project manifest at any time
- The linter will warn if `parentId` references a non-existent project
- The linter will error on circular parent references (e.g., A→B→A)
- Child projects do not inherit any behavior from parents; this is purely for organization
- Create child projects using: `aof create-project <id> --parent <parentId>`

## Backup Location

Backups are created at `<vault-root>/tasks.backup-<timestamp>` where the timestamp is ISO-8601 format with colons/dots replaced by hyphens for filesystem safety.

**Example:**
```
tasks.backup-2026-01-15T12-00-00-000Z
```

## Troubleshooting

### Migration fails midway

If the migration process is interrupted, you can safely re-run it. The tool is designed to be idempotent.

### Rollback doesn't find a backup

If you get "No backup directory found", check:
- Are there any `tasks.backup-*` directories in your vault root?
- If not, you may need to restore from your own backups.

### Tasks missing after migration

Check:
1. The backup directory: `ls tasks.backup-*/tasks/`
2. The migrated location: `ls Projects/_inbox/tasks/`
3. If files are in the backup but not migrated, re-run migration (it will copy missing files).

### Need to migrate to a different project (not _inbox)

The current tooling only supports migration to `_inbox`. For multi-project splits, you'll need to manually organize tasks after migration using the `aof project` commands (to be implemented in TASK-001).

## Related Commands

- `aof project create` (upcoming): Create new projects beyond `_inbox`.
- `aof project lint`: Validate project structure and manifests.
- `aof lint`: Validate tasks within a project.

## See Also

- [Projects v0 Specification](./projects-v0.md)
- [Task Schema](./schemas/task.md)
- [Project Manifest Schema](./schemas/project.md)
