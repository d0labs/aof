#!/usr/bin/env node
import { program } from "./program.js";

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
