#!/usr/bin/env node

if (process.env.CI === "true") {
  process.exit(0);
}

const lines = [
  "[cc-launcher] installed npm bins: ccodex, cclaude",
  "[cc-launcher] npm bin is the primary entrypoint; shell alias is optional only.",
  "[cc-launcher] run `ccodex doctor` after installation to verify ~/.cc-switch/cc-switch.db",
];

process.stderr.write(`${lines.join("\n")}\n`);
