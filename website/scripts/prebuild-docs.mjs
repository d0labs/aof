#!/usr/bin/env node
/**
 * prebuild-docs.mjs — Copies docs/ → website/src/content/docs/ at build time.
 *
 * Three steps:
 * 1. Clear website/src/content/docs/ (ephemeral, gitignored)
 * 2. Copy docs/** with transformations:
 *    - Inject frontmatter if missing (title from first # heading)
 *    - Remove first # heading (Starlight renders title from frontmatter)
 *    - Rewrite relative .md links to extensionless paths for Starlight routing
 * 3. Copy website/src/overrides/** on top (overrides win)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve } from "node:path";

const ROOT = resolve(new URL("../../", import.meta.url).pathname);
const DOCS_DIR = join(ROOT, "docs");
const CONTENT_DIR = join(ROOT, "website", "src", "content", "docs");
const OVERRIDES_DIR = join(ROOT, "website", "src", "overrides");

// ── Step 1: Clear destination ────────────────────────────────────────────────

function clearDest() {
  if (existsSync(CONTENT_DIR)) {
    rmSync(CONTENT_DIR, { recursive: true, force: true });
  }
  mkdirSync(CONTENT_DIR, { recursive: true });
}

// ── Step 2: Copy + transform docs/ ──────────────────────────────────────────

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Rewrite relative `.md` links to extensionless paths for Starlight.
 *
 * Examples (from a file in docs/guide/):
 *   [text](../dev/architecture.md)        → [text](/dev/architecture)
 *   [text](task-format.md#section)        → [text](/guide/task-format#section)
 *   [text](../guide/workflow-gates.md)    → [text](/guide/workflow-gates)
 *   [text](cascading-dependencies.md)     → [text](/guide/cascading-dependencies)
 *
 * Absolute links (starting with /) and external URLs are left untouched.
 */
function rewriteLinks(content, fileRelDir) {
  // Match markdown links: [text](target)
  // But skip links inside fenced code blocks
  const lines = content.split("\n");
  let inCodeBlock = false;
  const result = [];

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Rewrite markdown links on this line
    const rewritten = line.replace(
      /\[([^\]]*)\]\(([^)]+)\)/g,
      (match, text, target) => {
        // Skip external URLs, absolute paths, and anchors-only
        if (target.startsWith("http") || target.startsWith("#") || target.startsWith("/")) {
          return match;
        }

        // Only process .md links
        if (!target.includes(".md")) {
          return match;
        }

        // Split target into path and fragment
        const [pathPart, fragment] = target.split("#");

        // Resolve relative path to absolute from docs root
        const resolved = posix.normalize(posix.join(fileRelDir, pathPart));

        // Remove .md extension
        const withoutExt = resolved.replace(/\.md$/, "");

        // Build absolute path
        const absPath = "/" + withoutExt + (fragment ? "#" + fragment : "");

        return `[${text}](${absPath})`;
      }
    );

    result.push(rewritten);
  }

  return result.join("\n");
}

function hasFrontmatter(content) {
  return content.startsWith("---\n") || content.startsWith("---\r\n");
}

function extractAndInjectFrontmatter(content) {
  if (hasFrontmatter(content)) {
    return content;
  }

  // Extract title from first # heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Untitled";

  // Remove the heading line
  const body = content.replace(/^#\s+.+\n\n?/, "");

  return `---\ntitle: "${title.replace(/"/g, '\\"')}"\n---\n\n${body}`;
}

function transformFile(content, relPath) {
  // Inject frontmatter if missing
  let transformed = extractAndInjectFrontmatter(content);

  // Rewrite relative .md links
  const relDir = posix.dirname(relPath);
  transformed = rewriteLinks(transformed, relDir);

  return transformed;
}

function copyDocs() {
  const files = walk(DOCS_DIR);
  let count = 0;

  for (const srcPath of files) {
    const relPath = relative(DOCS_DIR, srcPath);
    const destPath = join(CONTENT_DIR, relPath);

    // Ensure destination directory exists
    mkdirSync(dirname(destPath), { recursive: true });

    if (extname(srcPath) === ".md") {
      const content = readFileSync(srcPath, "utf-8");
      const transformed = transformFile(content, relPath);
      writeFileSync(destPath, transformed, "utf-8");
      count++;
    } else {
      // Copy non-md files as-is (images, YAML examples, etc.)
      cpSync(srcPath, destPath);
    }
  }

  return count;
}

// ── Step 3: Copy overrides on top ───────────────────────────────────────────

function copyOverrides() {
  if (!existsSync(OVERRIDES_DIR)) {
    return 0;
  }

  const files = walk(OVERRIDES_DIR);
  let count = 0;

  for (const srcPath of files) {
    const relPath = relative(OVERRIDES_DIR, srcPath);
    const destPath = join(CONTENT_DIR, relPath);

    mkdirSync(dirname(destPath), { recursive: true });
    cpSync(srcPath, destPath);
    count++;
  }

  return count;
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log("prebuild-docs: clearing website/src/content/docs/");
clearDest();

console.log("prebuild-docs: copying docs/ → website/src/content/docs/");
const docCount = copyDocs();
console.log(`prebuild-docs: copied ${docCount} docs files`);

console.log("prebuild-docs: copying overrides on top");
const overrideCount = copyOverrides();
console.log(`prebuild-docs: copied ${overrideCount} override files`);

console.log("prebuild-docs: done");
