import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "index.ts");
const distDir = join(root, "dist");
const dest = join(distDir, "index.ts");

await mkdir(distDir, { recursive: true });
await copyFile(src, dest);
