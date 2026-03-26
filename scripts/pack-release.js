#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, "package.json");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const STABLE_TARBALL_NAME = "cc-launcher.tgz";
const DEFAULT_NPM_CACHE_DIR = path.join(os.tmpdir(), "cc-launcher-npm-cache");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || DEFAULT_NPM_CACHE_DIR,
      npm_config_cache: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || DEFAULT_NPM_CACHE_DIR,
    },
  });

  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }

  return result.stdout.trim();
}

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
const version = packageJson.version;
const versionedTarballName = `cc-launcher-${version}.tgz`;
const rawOutput = run("npm", ["pack", "--json"]);
const [packResult] = JSON.parse(rawOutput);

if (!packResult?.filename || !fs.existsSync(path.join(ROOT_DIR, packResult.filename))) {
  fail("npm pack did not produce a tarball.");
}

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

const sourceTarballPath = path.join(ROOT_DIR, packResult.filename);
const versionedTarballPath = path.join(DIST_DIR, versionedTarballName);
const stableTarballPath = path.join(DIST_DIR, STABLE_TARBALL_NAME);

fs.renameSync(sourceTarballPath, versionedTarballPath);
fs.copyFileSync(versionedTarballPath, stableTarballPath);

process.stdout.write(`${JSON.stringify({
  version,
  versionedTarball: versionedTarballPath,
  stableTarball: stableTarballPath,
}, null, 2)}\n`);
