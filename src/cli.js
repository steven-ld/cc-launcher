#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectCliContext } from "./app-context.js";
import { formatDoctorReport, formatInitReport, inspectRuntimeSetup } from "./init-doctor.js";
import { pruneManagedRuntimeHomes } from "./managed-profile-state.js";
import { loadPoolConfig, pickProfile, resolveProxyConfig } from "./pool-config.js";
import { selectLaunchProfile, getRateLimitCacheStatus, startRateLimitCacheRefresh } from "./profile-selection.js";
import { getProfileStateManager } from "./profile-state.js";
import { runProxyCommand } from "./proxy-server.js";
import { formatUsageReport, readCachedRateLimits, readOfficialRateLimits } from "./rate-limits.js";
import { prepareCodexHome, resolveRuntimeRoot } from "./runtime-home.js";

function buildHelpText(cliContext) {
  const usageLine = cliContext.supportsUsage
    ? `  ${cliContext.cliName} usage [--pool-config FILE] [--pool-source TYPE] [--pool-source-db FILE] [--pool-profile NAME] [--pool-bin COMMAND] [--pool-json]`
    : `  ${cliContext.cliName} usage ...                         Available only for ccodex`;

  return `CC Launcher

Usage:
  ${cliContext.cliName} init [--pool-config FILE] [--pool-source TYPE] [--pool-source-db FILE]
  ${cliContext.cliName} doctor [--pool-config FILE] [--pool-source TYPE] [--pool-source-db FILE]
  ${cliContext.cliName} list [--pool-config FILE] [--pool-source TYPE] [--pool-source-db FILE]
  ${cliContext.cliName} pick [--pool-config FILE] [--pool-source TYPE] [--pool-source-db FILE] [--pool-profile NAME]
  ${cliContext.cliName} proxy [--pool-config FILE] [--pool-source TYPE] [--pool-source-db FILE] [--pool-profile NAME] [--pool-bin COMMAND] [--pool-proxy-host HOST] [--pool-proxy-port PORT]
  ${cliContext.cliName} run [--pool-config FILE] [--pool-source TYPE] [--pool-source-db FILE] [--pool-profile NAME] [--pool-bin COMMAND] [--pool-dry-run] [-- ${cliContext.command.toUpperCase()}_ARGS...]
${usageLine}

Behavior:
  1. If --pool-config or CODEX_POOL_CONFIG is set, use that config.
  2. Otherwise, try ~/.cc-launcher/config.json.
  3. If no config is found, auto-discover ~/.cc-switch/cc-switch.db.

Aliases:
  --pool-list             Same as list
  --pool-config FILE      Pool config JSON file
  --config FILE           Alias of --pool-config
  --pool-source TYPE      Dynamic profile source, e.g. cc-switch
  --source TYPE           Alias of --pool-source
  --pool-source-db FILE   Override the source database/file path
  --source-db FILE        Alias of --pool-source-db
  --pool-profile NAME     Force one wrapper profile
  --profile NAME          Alias of --pool-profile
  --pool-dry-run          Only resolve profile and runtime path; do not write files or launch ${cliContext.command}
  --dry-run               Alias of --pool-dry-run
  --pool-bin COMMAND      Override configured launch command
  --bin COMMAND           Alias of --pool-bin
  --pool-proxy-host HOST  Override proxy listen host
  --proxy-host HOST       Alias of --pool-proxy-host
  --pool-proxy-port PORT  Override proxy listen port
  --proxy-port PORT       Alias of --pool-proxy-port
  --pool-json             Print usage output as JSON
  --json                  Alias of --pool-json
  --pool-help             Show this help

Examples:
  ${cliContext.cliName} init
  ${cliContext.cliName} doctor
  ${cliContext.cliName} list
  ${cliContext.cliName} proxy
  ${cliContext.cliName} run -- --help
  ${cliContext.cliName} run --pool-profile profile-a -- --help
`;
}

function printHelp(cliContext) {
  process.stdout.write(`${buildHelpText(cliContext)}\n`);
}

export function parseCliArgs(argv) {
  const args = [...argv];
  let command = "run";
  let configPath;
  let sourceType;
  let sourceDbPath;
  let profileName;
  let codexCommand;
  let proxyHost;
  let proxyPort;
  let dryRun = false;
  let poolList = false;
  let proxyStartOnly = false;
  let outputJson = false;
  let passthroughMode = false;
  const codexArgs = [];

  // Default to run mode with auto-load-balancing if no command specified
  if (args[0] && ["init", "doctor", "list", "pick", "proxy", "run", "usage", "cache", "status", "enable", "disable"].includes(args[0])) {
    command = args.shift();
  } else if (!args[0] || !args[0].startsWith("--")) {
    // No command or first arg is not a flag -> default to run with profile selection
    command = "run";
  }

  while (args.length > 0) {
    const current = args.shift();

    if (passthroughMode) {
      codexArgs.push(current);
      continue;
    }

    if (current === "--") {
      passthroughMode = true;
      continue;
    }

    if (current.startsWith("--pool-config=")) {
      configPath = current.slice("--pool-config=".length);
      continue;
    }

    if (current.startsWith("--pool-profile=")) {
      profileName = current.slice("--pool-profile=".length);
      continue;
    }

    if (current.startsWith("--pool-source=")) {
      sourceType = current.slice("--pool-source=".length);
      continue;
    }

    if (current.startsWith("--pool-source-db=")) {
      sourceDbPath = current.slice("--pool-source-db=".length);
      continue;
    }

    if (current.startsWith("--pool-bin=")) {
      codexCommand = current.slice("--pool-bin=".length);
      continue;
    }

    if (current.startsWith("--pool-proxy-host=")) {
      proxyHost = current.slice("--pool-proxy-host=".length);
      continue;
    }

    if (current.startsWith("--pool-proxy-port=")) {
      proxyPort = Number.parseInt(current.slice("--pool-proxy-port=".length), 10);
      if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) {
        throw new Error(`--pool-proxy-port requires a valid port.`);
      }
      continue;
    }

    switch (current) {
      case "--config":
      case "--pool-config":
        configPath = args.shift();
        if (!configPath) {
          throw new Error(`${current} requires a file path.`);
        }
        break;
      case "--profile":
      case "--pool-profile":
        profileName = args.shift();
        if (!profileName) {
          throw new Error(`${current} requires a profile name.`);
        }
        break;
      case "--source":
      case "--pool-source":
        sourceType = args.shift();
        if (!sourceType) {
          throw new Error(`${current} requires a source type.`);
        }
        break;
      case "--source-db":
      case "--pool-source-db":
        sourceDbPath = args.shift();
        if (!sourceDbPath) {
          throw new Error(`${current} requires a file path.`);
        }
        break;
      case "--dry-run":
      case "--pool-dry-run":
        dryRun = true;
        break;
      case "--bin":
      case "--pool-bin":
        codexCommand = args.shift();
        if (!codexCommand) {
          throw new Error(`${current} requires a command.`);
        }
        break;
      case "--proxy-host":
      case "--pool-proxy-host":
        proxyHost = args.shift();
        if (!proxyHost) {
          throw new Error(`${current} requires a host.`);
        }
        break;
      case "--proxy-port":
      case "--pool-proxy-port": {
        const rawProxyPort = args.shift();
        proxyPort = Number.parseInt(rawProxyPort, 10);
        if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) {
          throw new Error(`${current} requires a valid port.`);
        }
        break;
      }
      case "--json":
      case "--pool-json":
        outputJson = true;
        break;
      case "--pool-list":
        poolList = true;
        break;
      case "--pool-proxy-start-only":
      case "--proxy-start-only":
        proxyStartOnly = true;
        break;
      case "--help":
      case "-h":
      case "--pool-help":
        return { help: true };
      default:
        codexArgs.push(current);
        break;
    }
  }

  if (poolList) {
    command = "list";
  }

  return {
    help: false,
    command,
    configPath,
    sourceType,
    sourceDbPath,
    profileName,
    codexCommand,
    proxyHost,
    proxyPort,
    dryRun,
    outputJson,
    proxyStartOnly,
    codexArgs,
  };
}

function printProfile(profile, runtimeHome, cliContext) {
  process.stdout.write(`profile: ${profile.name}\n`);
  if (runtimeHome) {
    const label = cliContext.appType === "codex" ? "CODEX_HOME" : "runtime_home";
    process.stdout.write(`${label}: ${runtimeHome}\n`);
  }
}

function listProfiles(config) {
  for (const profile of config.profiles) {
    const weight = profile.weight ?? 1;
    const authSource = profile.authFile
      ? `authFile=${profile.authFile}`
      : profile.auth
        ? "auth=inline"
        : profile.env
          ? "env=inline"
          : "auth=none";
    process.stdout.write(`${profile.name}\tweight=${weight}\t${authSource}\n`);
  }
}

function spawnLauncher(command, args, env) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(command, args, {
      stdio: "inherit",
      env,
      shell: isWindows,  // Windows needs shell for .cmd files
    });

    const forwardSignal = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };

    ["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => {
      process.on(signal, forwardSignal);
    });

    const cleanup = () => {
      ["SIGINT", "SIGTERM", "SIGHUP"].forEach((eventName) => {
        process.removeListener(eventName, forwardSignal);
      });
    };

    child.on("exit", (code, signal) => {
      cleanup();

      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      resolve(code ?? 0);
    });

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function hasCliOption(args, optionName) {
  return args.some((arg) => arg === optionName || arg.startsWith(`${optionName}=`));
}

function buildLaunchArgs(cliContext, runtime, passthroughArgs) {
  if (cliContext.appType !== "claude") {
    return passthroughArgs;
  }

  const launchArgs = [...passthroughArgs];
  const injectedArgs = [];

  if (runtime.settingsJsonPath && !hasCliOption(launchArgs, "--settings")) {
    injectedArgs.push("--settings", runtime.settingsJsonPath);
  }

  if (!hasCliOption(launchArgs, "--setting-sources")) {
    injectedArgs.push("--setting-sources", "project,local");
  }

  return [...injectedArgs, ...launchArgs];
}

function isOfficialUsageCandidate(profile) {
  return Boolean(profile?.auth || profile?.authFile);
}

async function resolveUsageProfile({
  config,
  configDir,
  cliContext,
  profileName,
  launchCommand,
}) {
  if (profileName) {
    return pickProfile(config, { profileName });
  }

  if (config.profiles.length === 1) {
    return config.profiles[0];
  }

  const officialProfiles = config.profiles.filter(isOfficialUsageCandidate);
  if (officialProfiles.length === 0) {
    throw new Error("usage requires an official Codex auth profile. No official profiles were found.");
  }

  if (officialProfiles.length === 1) {
    return officialProfiles[0];
  }

  const strategyAwareSelection = await selectLaunchProfile({
    configDir,
    config: {
      ...config,
      profiles: officialProfiles,
    },
    cliContext,
    launchCommand,
    allowLiveProbe: true,
  });

  return strategyAwareSelection.profile;
}

async function syncManagedProfilesIfNeeded({ configDir, config, metadata, shouldWrite }) {
  if (!shouldWrite || !metadata?.source?.type) {
    return;
  }

  await pruneManagedRuntimeHomes({
    runtimeRoot: resolveRuntimeRoot(configDir, config),
    sourceType: metadata.source.type,
    profiles: metadata.managedProfiles ?? [],
  });
}

async function runInitOrDoctor(parsed, cliContext) {
  const report = await inspectRuntimeSetup({
    configPath: parsed.configPath,
    sourceType: parsed.sourceType,
    sourceDbPath: parsed.sourceDbPath,
    appType: cliContext.appType,
    defaultCommand: parsed.codexCommand || cliContext.command,
    cliName: cliContext.cliName,
  });

  const formatter = parsed.command === "init" ? formatInitReport : formatDoctorReport;
  process.stdout.write(`${formatter(report)}\n`);
  return report.ready ? 0 : 1;
}

function printLaunchSelectionDiagnostics(diagnostics) {
  if (!diagnostics || diagnostics.mode === "explicit" || diagnostics.mode === "random") {
    return;
  }

  if (diagnostics.mode === "max-remaining-5h") {
    process.stderr.write(
      `[cc-launcher] selected official profile by 5h remaining: ${diagnostics.selectedRemaining5hPercent}% remaining.\n`,
    );

    if ((diagnostics.failedProbes?.length ?? 0) > 0) {
      process.stderr.write(
        `[cc-launcher] skipped ${diagnostics.failedProbes.length} official profile(s) that failed live auth/rate-limit probing.\n`,
      );
    }
    return;
  }

  if (diagnostics.mode === "random-fallback" && diagnostics.reason === "live_probe_disabled") {
    process.stderr.write("[cc-launcher] dry-run skipped live official probing; using random fallback.\n");
    return;
  }

  if (diagnostics.mode === "random-fallback" && diagnostics.reason === "no_official_candidates") {
    process.stderr.write("[cc-launcher] no official Codex profiles found; using random fallback.\n");
    return;
  }

  if (diagnostics.mode === "random-fallback" && diagnostics.reason === "official_probe_failed") {
    process.stderr.write("[cc-launcher] official Codex profiles failed live probing; using non-official fallback.\n");
  }
}

export async function main(argv = process.argv.slice(2), cliContext = detectCliContext(process.argv[1])) {
  const parsed = parseCliArgs(argv);
  
  // Initialize profile state manager early
  const stateManager = getProfileStateManager();
  await stateManager.load();
  
  if (parsed.help) {
    printHelp(cliContext);
    return 0;
  }

  if (parsed.command === "init" || parsed.command === "doctor") {
    return runInitOrDoctor(parsed, cliContext);
  }

  const { config, configDir, metadata } = await loadPoolConfig(parsed.configPath, {
    sourceType: parsed.sourceType,
    sourceDbPath: parsed.sourceDbPath,
    appType: cliContext.appType,
    cliName: cliContext.cliName,
  });

  if (parsed.command === "list") {
    listProfiles(config);
    return 0;
  }

  if (parsed.command === "cache") {
    if (cliContext.appType !== "codex") {
      throw new Error(`${cliContext.cliName} does not support cache command.`);
    }

    // Trigger a cache refresh
    const launchCommand = parsed.codexCommand || config.codexCommand || cliContext.command;
    const cache = startRateLimitCacheRefresh(config.profiles, { codexCommand: launchCommand });

    // Wait for initial refresh to complete (up to 30 seconds)
    const startTime = Date.now();
    while (cache.isRefreshing && Date.now() - startTime < 30000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const status = getRateLimitCacheStatus();
    const sorted = cache.getSortedProfiles();

    if (parsed.outputJson) {
      process.stdout.write(JSON.stringify({ status, profiles: sorted }, null, 2) + "\n");
    } else {
      process.stdout.write("Rate Limit Cache Status\n");
      process.stdout.write("========================\n");
      process.stdout.write(`Cache loaded: ${status.hasCache ? "yes" : "no"}\n`);
      process.stdout.write(`Profiles cached: ${status.profileCount}\n`);
      process.stdout.write(`Last updated: ${status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "never"}\n`);
      process.stdout.write(`Refreshing: ${status.isRefreshing ? "yes" : "no"}\n`);
      process.stdout.write("\nProfile Rankings (by 5h remaining):\n");
      process.stdout.write("--------------------------------\n");
      for (const entry of sorted) {
        const pct = entry.remaining5hPercent.toFixed(1);
        const bar = "█".repeat(Math.floor(entry.remaining5hPercent / 5)) + "░".repeat(20 - Math.floor(entry.remaining5hPercent / 5));
        process.stdout.write(`${entry.profileName}\n`);
        process.stdout.write(`  ${bar} ${pct}% remaining\n`);
      }
      if (status.errorCount > 0) {
        process.stdout.write(`\nErrors: ${status.errorCount} profile(s) failed to probe\n`);
      }
    }
    return 0;
  }

  if (parsed.command === "status") {
    const stateManager = getProfileStateManager();
    await stateManager.load();
    
    const disabled = stateManager.getDisabledProfiles();
    
    if (parsed.outputJson) {
      process.stdout.write(JSON.stringify({
        total: config.profiles.length,
        enabled: config.profiles.filter((p) => !stateManager.isDisabled(p.name)).length,
        disabled,
      }, null, 2) + "\n");
    } else {
      process.stdout.write("Profile Status\n");
      process.stdout.write("==============\n");
      process.stdout.write(`Total profiles: ${config.profiles.length}\n`);
      process.stdout.write(`Enabled: ${config.profiles.filter((p) => !stateManager.isDisabled(p.name)).length}\n`);
      process.stdout.write(`Disabled: ${disabled.length}\n`);
      
      if (disabled.length > 0) {
        process.stdout.write("\nDisabled profiles:\n");
        process.stdout.write("------------------\n");
        for (const entry of disabled) {
          const remainingMin = Math.ceil(entry.remainingMs / 60000);
          process.stdout.write(`${entry.name}\n`);
          process.stdout.write(`  Reason: ${entry.reason}\n`);
          process.stdout.write(`  Retry in: ${remainingMin} minutes\n`);
        }
      }
    }
    return 0;
  }

  if (parsed.command === "enable") {
    const stateManager = getProfileStateManager();
    await stateManager.load();
    
    if (!parsed.profileName) {
      throw new Error("--pool-profile is required for enable command");
    }
    
    const wasDisabled = stateManager.isDisabled(parsed.profileName);
    stateManager.enable(parsed.profileName);
    
    if (wasDisabled) {
      process.stdout.write(`Enabled profile: ${parsed.profileName}\n`);
    } else {
      process.stdout.write(`Profile ${parsed.profileName} was not disabled.\n`);
    }
    return 0;
  }

  if (parsed.command === "disable") {
    const stateManager = getProfileStateManager();
    await stateManager.load();
    
    if (!parsed.profileName) {
      throw new Error("--pool-profile is required for disable command");
    }
    
    const wasEnabled = !stateManager.isDisabled(parsed.profileName);
    stateManager.disable(parsed.profileName, "manual");
    
    if (wasEnabled) {
      process.stdout.write(`Disabled profile: ${parsed.profileName}\n`);
      process.stdout.write(`Will retry in 30 minutes.\n`);
    } else {
      process.stdout.write(`Profile ${parsed.profileName} was already disabled.\n`);
    }
    return 0;
  }

  if (parsed.command === "proxy") {
    await syncManagedProfilesIfNeeded({
      configDir,
      config,
      metadata,
      shouldWrite: true,
    });
    return runProxyCommand({
      parsed,
      config,
      configDir,
      cliContext,
    });
  }

  if (parsed.command === "usage") {
    if (!cliContext.supportsUsage) {
      throw new Error(`${cliContext.cliName} does not support usage. Use ccodex usage instead.`);
    }

    const launchCommand = parsed.codexCommand || config.codexCommand || cliContext.command;
    const profile = await resolveUsageProfile({
      config,
      configDir,
      cliContext,
      profileName: parsed.profileName,
      launchCommand,
    });
    await syncManagedProfilesIfNeeded({
      configDir,
      config,
      metadata,
      shouldWrite: true,
    });
    const runtime = await prepareCodexHome({
      configDir,
      config,
      profile,
      appType: cliContext.appType,
      writeFiles: true,
    });

    let source = "official-live";
    let snapshot;
    let cachedMetadata = null;

    try {
      const result = await readOfficialRateLimits({
        codexCommand: launchCommand,
        env: runtime.env,
        cwd: process.cwd(),
      });
      snapshot = result.snapshot;
    } catch (error) {
      const cached = await readCachedRateLimits({
        codexHome: runtime.runtimeHome,
      }).catch(() => null);

      if (!cached) {
        throw new Error(`Failed to read official rate limits: ${error.message}`);
      }

      source = "cached-official-snapshot";
      snapshot = cached.snapshot;
      cachedMetadata = {
        filePath: cached.filePath,
        timestamp: cached.timestamp,
      };
      process.stderr.write(
        "[cc-launcher] live official rate limit read failed, using cached official snapshot instead.\n",
      );
    }

    if (parsed.outputJson) {
      process.stdout.write(
        `${JSON.stringify({
          profile: profile.name,
          source,
          runtimeHome: runtime.runtimeHome,
          snapshot,
          cached: cachedMetadata,
        }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${formatUsageReport({ profileName: profile.name, snapshot, source })}\n`);
      if (cachedMetadata?.timestamp) {
        process.stdout.write(`cached_at: ${cachedMetadata.timestamp}\n`);
      }
    }
    return 0;
  }

  const launchCommand = parsed.codexCommand || config.codexCommand || cliContext.command;
  const selection = await selectLaunchProfile({
    configDir,
    config,
    cliContext,
    profileName: parsed.profileName,
    launchCommand,
    allowLiveProbe: parsed.command === "run" && !parsed.dryRun,
  });
  const profile = selection.profile;
  printLaunchSelectionDiagnostics(selection.diagnostics);
  await syncManagedProfilesIfNeeded({
    configDir,
    config,
    metadata,
    shouldWrite: parsed.command === "run" && !parsed.dryRun,
  });
  const runtime = await prepareCodexHome({
    configDir,
    config,
    profile,
    appType: cliContext.appType,
    writeFiles: parsed.command === "run" && !parsed.dryRun,
  });

  if (parsed.command === "pick") {
    printProfile(profile, runtime.runtimeHome, cliContext);
    return 0;
  }

  printProfile(profile, runtime.runtimeHome, cliContext);
  const launchArgs = buildLaunchArgs(cliContext, runtime, parsed.codexArgs);
  process.stderr.write(`launching: ${launchCommand}${launchArgs.length ? ` ${launchArgs.join(" ")}` : ""}\n`);

  if (parsed.dryRun) {
    return 0;
  }

  return spawnLauncher(launchCommand, launchArgs, runtime.env);
}

function isExecutedDirectly() {
  const entryFile = process.argv[1];
  if (!entryFile) {
    return false;
  }

  return path.resolve(entryFile) === fileURLToPath(import.meta.url);
}

if (isExecutedDirectly()) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[cc-launcher] ${message}\n`);
      process.exitCode = 1;
    },
  );
}
