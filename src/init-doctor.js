import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";

import { DEFAULT_PRODUCT_CONFIG_PATH, inspectConfigDiscovery, loadPoolConfig } from "./pool-config.js";
import { DEFAULT_CC_SWITCH_DB_PATH, resolveCcSwitchDbPath } from "./provider-sources/cc-switch.js";

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function findCommand(command) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

export async function inspectRuntimeSetup({
  configPath,
  sourceType,
  sourceDbPath,
  appType,
  defaultCommand,
  cliName,
}) {
  const configDiscovery = await inspectConfigDiscovery(configPath);
  const defaultDbPath = resolveCcSwitchDbPath(sourceDbPath ?? DEFAULT_CC_SWITCH_DB_PATH);
  const defaultDbExists = await pathExists(defaultDbPath);
  const commandPath = findCommand(defaultCommand);

  let loadResult = null;
  let loadError = null;

  try {
    loadResult = await loadPoolConfig(configPath, {
      sourceType,
      sourceDbPath,
      appType,
      cliName,
    });
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const profileCount = loadResult?.config.profiles.length ?? 0;
  const sourceMetadata = loadResult?.metadata?.source ?? null;
  const resolvedConfigPath = loadResult?.configPath ?? configDiscovery.path;
  const ready = Boolean(commandPath) && !loadError && profileCount > 0;

  return {
    cliName,
    appType,
    defaultCommand,
    commandPath,
    configCandidates: configDiscovery.candidates,
    configPath: resolvedConfigPath,
    defaultDbPath,
    defaultDbExists,
    loadError,
    profileCount,
    sourceMetadata,
    ready,
  };
}

function formatPathStatus(label, filePath, ok) {
  return `${label}: ${filePath} [${ok ? "ok" : "missing"}]`;
}

function formatCommandStatus(report) {
  if (report.commandPath) {
    return `command: ${report.defaultCommand} -> ${report.commandPath} [ok]`;
  }

  return `command: ${report.defaultCommand} [missing]`;
}

function formatProfileStatus(report) {
  if (report.loadError) {
    return `profiles: unavailable [error]`;
  }

  return `profiles: ${report.profileCount} [ok]`;
}

function formatConfigStatus(report) {
  if (report.configPath) {
    return `config: ${report.configPath} [ok]`;
  }

  const defaultConfigPath = report.configCandidates[0] ?? DEFAULT_PRODUCT_CONFIG_PATH;
  return `config: ${defaultConfigPath} [missing]`;
}

function formatNextStep(report) {
  if (!report.commandPath) {
    return `next: install ${report.defaultCommand}, then rerun ${report.cliName} doctor`;
  }

  if (report.loadError) {
    return `next: ${report.loadError}`;
  }

  return `next: run ${report.cliName} list or ${report.cliName} run -- --help`;
}

export function formatDoctorReport(report) {
  const lines = [
    `doctor: ${report.cliName}`,
    `cli: ${report.cliName}`,
    `app: ${report.appType}`,
    formatCommandStatus(report),
    formatConfigStatus(report),
    formatPathStatus("default_cc_switch_db", report.defaultDbPath, report.defaultDbExists),
    formatProfileStatus(report),
  ];

  if (report.sourceMetadata?.dbPath) {
    lines.push(`source_db: ${report.sourceMetadata.dbPath}`);
  }

  if (report.loadError) {
    lines.push(`issue: ${report.loadError}`);
  }

  lines.push(`status: ${report.ready ? "ready" : "not_ready"}`);
  lines.push(formatNextStep(report));
  return lines.join("\n");
}

export function formatInitReport(report) {
  if (!report.ready) {
    return formatDoctorReport(report);
  }

  const lines = [
    `init: ${report.cliName}`,
    `initialized: ${report.cliName}`,
    `app: ${report.appType}`,
    `profiles: ${report.profileCount}`,
  ];

  if (report.sourceMetadata?.dbPath) {
    lines.push(`source_db: ${report.sourceMetadata.dbPath}`);
  } else if (report.configPath) {
    lines.push(`config: ${report.configPath}`);
  }

  lines.push("status: ready");
  lines.push(`next: ${report.cliName} list`);
  lines.push(`next: ${report.cliName} run -- --help`);
  return lines.join("\n");
}
