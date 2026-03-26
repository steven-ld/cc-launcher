#!/usr/bin/env node

import { main } from "../src/cli.js";

try {
  const exitCode = await main(process.argv.slice(2));
  if (typeof exitCode === "number") {
    process.exitCode = exitCode;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[codex-proxy] ${message}\n`);
  process.exitCode = 1;
}
