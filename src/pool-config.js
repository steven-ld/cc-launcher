import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveAppContext } from "./app-context.js";
import {
  DEFAULT_CC_SWITCH_DB_PATH,
  loadCcSwitchSource,
  resolveCcSwitchDbPath,
} from "./provider-sources/cc-switch.js";

export const DEFAULT_PRODUCT_CONFIG_PATH = "~/.cc-launcher/config.json";
const DEFAULT_DIRECT_SOURCE_RUNTIME_ROOT = "~/.cc-launcher/runtime";
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RANDOM_SELECTION_STRATEGY = "random";
export const MAX_REMAINING_5H_SELECTION_STRATEGY = "max-remaining-5h";

function isSupportedSelectionStrategy(strategy) {
  return strategy === RANDOM_SELECTION_STRATEGY || strategy === MAX_REMAINING_5H_SELECTION_STRATEGY;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return filePath;
  }

  if (filePath === "~") {
    return os.homedir();
  }

  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function collectConfigCandidates(explicitPath) {
  const candidates = [];
  const required = Boolean(explicitPath || process.env.CODEX_POOL_CONFIG);

  if (explicitPath) {
    candidates.push(expandHome(explicitPath));
  } else if (process.env.CODEX_POOL_CONFIG) {
    candidates.push(expandHome(process.env.CODEX_POOL_CONFIG));
  } else {
    candidates.push(expandHome(DEFAULT_PRODUCT_CONFIG_PATH));
  }

  return {
    candidates,
    required,
  };
}

export async function inspectConfigDiscovery(explicitPath) {
  const { candidates, required } = collectConfigCandidates(explicitPath);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (await pathExists(resolved)) {
      return {
        path: resolved,
        candidates: candidates.map((item) => path.resolve(item)),
        required,
      };
    }
  }

  return {
    path: null,
    candidates: candidates.map((item) => path.resolve(item)),
    required,
  };
}

export async function resolveConfigPath(explicitPath) {
  const inspection = await inspectConfigDiscovery(explicitPath);

  if (inspection.path) {
    return inspection.path;
  }

  throw new Error(
    `No pool config found. Checked: ${inspection.candidates.join(", ")}`,
  );
}

export async function loadPoolConfig(explicitPath, sourceOptions = {}) {
  return loadPoolConfigFromSource(explicitPath, sourceOptions);
}

function buildDefaultSourceBackedConfig({ sourceType, sourceDbPath, appType = "codex" } = {}) {
  const appContext = resolveAppContext(appType);
  const profileSource = sourceType
    ? {
        type: sourceType,
        ...(sourceDbPath ? { dbPath: sourceDbPath } : {}),
        appType: appContext.appType,
      }
    : undefined;

  return {
    version: 1,
    codexCommand: appContext.command,
    runtimeRoot: DEFAULT_DIRECT_SOURCE_RUNTIME_ROOT,
    sharedCodexHome: appContext.sharedHome,
    selection: {
      strategy: RANDOM_SELECTION_STRATEGY,
    },
    ...(appContext.appType === "codex"
      ? {
          sharedEnv: {
            OPENAI_API_KEY: null,
          },
        }
      : {}),
    ...(profileSource ? { profileSource } : {}),
  };
}

function validateProfileSource(source, label) {
  if (!isPlainObject(source)) {
    throw new Error(`${label} must be an object.`);
  }

  if (!source.type || typeof source.type !== "string") {
    throw new Error(`${label}.type must be a non-empty string.`);
  }

  if (source.type !== "cc-switch") {
    throw new Error(`Unsupported profile source type: ${source.type}`);
  }

  if (source.dbPath !== undefined && typeof source.dbPath !== "string") {
    throw new Error(`${label}.dbPath must be a string when provided.`);
  }

  if (source.appType !== undefined && typeof source.appType !== "string") {
    throw new Error(`${label}.appType must be a string when provided.`);
  }
}

export function validatePoolConfig(config, configPath = "<config>", options = {}) {
  const { allowSourceWithoutProfiles = false } = options;
  if (!isPlainObject(config)) {
    throw new Error(`Pool config ${configPath} must be a JSON object.`);
  }

  if (config.version !== undefined && config.version !== 1) {
    throw new Error(`Pool config ${configPath} has unsupported version: ${config.version}`);
  }

  if (config.profileSource !== undefined) {
    validateProfileSource(config.profileSource, "profileSource");
  }

  const hasProfiles = Array.isArray(config.profiles) && config.profiles.length > 0;
  if (!hasProfiles && !(allowSourceWithoutProfiles && config.profileSource !== undefined)) {
    throw new Error(`Pool config ${configPath} must include a non-empty profiles array.`);
  }

  const seenNames = new Set();
  (config.profiles ?? []).forEach((profile, index) => {
    if (!isPlainObject(profile)) {
      throw new Error(`profiles[${index}] must be an object.`);
    }

    if (!profile.name || typeof profile.name !== "string") {
      throw new Error(`profiles[${index}].name must be a non-empty string.`);
    }

    if (seenNames.has(profile.name)) {
      throw new Error(`Duplicate profile name: ${profile.name}`);
    }
    seenNames.add(profile.name);

    if (profile.weight !== undefined) {
      if (typeof profile.weight !== "number" || !Number.isFinite(profile.weight) || profile.weight <= 0) {
        throw new Error(`profiles[${index}].weight must be a positive number.`);
      }
    }

    validateEnvObject(profile.env, `profiles[${index}].env`);

    if (profile.auth !== undefined && !isPlainObject(profile.auth)) {
      throw new Error(`profiles[${index}].auth must be an object when provided.`);
    }

    if (profile.authFile !== undefined && typeof profile.authFile !== "string") {
      throw new Error(`profiles[${index}].authFile must be a string when provided.`);
    }

    if (profile.auth !== undefined && profile.authFile !== undefined) {
      throw new Error(`profiles[${index}] cannot define both auth and authFile.`);
    }

    if (profile.configToml !== undefined && typeof profile.configToml !== "string") {
      throw new Error(`profiles[${index}].configToml must be a string when provided.`);
    }

    if (profile.configTomlFile !== undefined && typeof profile.configTomlFile !== "string") {
      throw new Error(`profiles[${index}].configTomlFile must be a string when provided.`);
    }

    if (profile.configToml !== undefined && profile.configTomlFile !== undefined) {
      throw new Error(`profiles[${index}] cannot define both configToml and configTomlFile.`);
    }
  });

  validateEnvObject(config.sharedEnv, "sharedEnv");

  if (config.sharedConfigToml !== undefined && typeof config.sharedConfigToml !== "string") {
    throw new Error(`sharedConfigToml must be a string when provided.`);
  }

  if (config.sharedConfigTomlFile !== undefined && typeof config.sharedConfigTomlFile !== "string") {
    throw new Error(`sharedConfigTomlFile must be a string when provided.`);
  }

  if (config.inheritGlobalConfig !== undefined && typeof config.inheritGlobalConfig !== "boolean") {
    throw new Error(`inheritGlobalConfig must be a boolean when provided.`);
  }

  if (config.selection !== undefined && !isPlainObject(config.selection)) {
    throw new Error(`selection must be an object when provided.`);
  }

  const strategy = config.selection?.strategy ?? RANDOM_SELECTION_STRATEGY;
  if (!isSupportedSelectionStrategy(strategy)) {
    throw new Error(`Unsupported selection strategy: ${strategy}`);
  }

  if (config.codexCommand !== undefined && typeof config.codexCommand !== "string") {
    throw new Error(`codexCommand must be a string when provided.`);
  }

  if (config.runtimeRoot !== undefined && typeof config.runtimeRoot !== "string") {
    throw new Error(`runtimeRoot must be a string when provided.`);
  }

  if (config.sharedCodexHome !== undefined && typeof config.sharedCodexHome !== "string") {
    throw new Error(`sharedCodexHome must be a string when provided.`);
  }

  if (config.sharedHomeEntries !== undefined) {
    if (
      !Array.isArray(config.sharedHomeEntries) ||
      config.sharedHomeEntries.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      throw new Error(`sharedHomeEntries must be an array of non-empty strings.`);
    }
  }
}

async function readConfigJson(configPath) {
  const raw = await fs.readFile(configPath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse pool config ${configPath}: ${error.message}`);
  }
}

function buildManagedProfiles(profiles) {
  return profiles
    .filter((profile) => profile?.sourceMeta?.type && profile?.sourceMeta?.providerId)
    .map((profile) => ({
      key: profile.sourceMeta.providerId,
      runtimeDirName: profile.name,
      name: profile.name,
    }));
}

async function materializeProfileSource(config, configDir, sourceOptions = {}) {
  const source = sourceOptions.sourceType
    ? {
        type: sourceOptions.sourceType,
        ...(sourceOptions.sourceDbPath ? { dbPath: sourceOptions.sourceDbPath } : {}),
        ...(sourceOptions.appType ? { appType: sourceOptions.appType } : {}),
      }
    : config.profileSource;

  if (!source) {
    return {
      config,
      metadata: null,
    };
  }

  if (source.type !== "cc-switch") {
    throw new Error(`Unsupported profile source type: ${source.type}`);
  }

  const appType = source.appType ?? sourceOptions.appType ?? "codex";
  const cliName = sourceOptions.cliName ?? resolveAppContext(appType).cliName;

  const resolvedSourceDbPath = sourceOptions.sourceDbPath
    ? resolvePathFromConfig(configDir, sourceOptions.sourceDbPath)
    : source.dbPath
      ? resolvePathFromConfig(configDir, source.dbPath)
      : resolveCcSwitchDbPath(DEFAULT_CC_SWITCH_DB_PATH);

  if (!(await pathExists(resolvedSourceDbPath))) {
    throw new Error(
      `No cc-switch database found at ${resolvedSourceDbPath}. Install cc-switch and sign in first, or pass --pool-source-db FILE. Then run ${cliName} init.`,
    );
  }

  const imported = loadCcSwitchSource({
    dbPath: resolvedSourceDbPath,
    appType,
  });
  const baseProfiles = Array.isArray(config.profiles) ? config.profiles : [];

  if (imported.profiles.length === 0 && baseProfiles.length === 0) {
    throw new Error(
      `No usable ${appType} profiles found in ${resolvedSourceDbPath}. Add an account in cc-switch first, then run ${cliName} init.`,
    );
  }

  return {
    config: {
      ...config,
      profileSource: {
        ...source,
        ...(resolvedSourceDbPath ? { dbPath: resolvedSourceDbPath } : {}),
      },
      profiles: [...baseProfiles, ...imported.profiles],
    },
    metadata: {
      ...imported.metadata,
      managedProfiles: buildManagedProfiles(imported.profiles),
    },
  };
}

export async function loadPoolConfigFromSource(explicitPath, sourceOptions = {}) {
  const configInspection = await inspectConfigDiscovery(explicitPath);
  const appContext = resolveAppContext(sourceOptions.appType ?? "codex");
  const cliName = sourceOptions.cliName ?? appContext.cliName;
  const hasExplicitConfigRequest = Boolean(explicitPath || process.env.CODEX_POOL_CONFIG);
  const defaultDbPath = resolveCcSwitchDbPath(sourceOptions.sourceDbPath ?? DEFAULT_CC_SWITCH_DB_PATH);
  const shouldAutoloadCcSwitch =
    !configInspection.path && !configInspection.required && !sourceOptions.sourceType && (await pathExists(defaultDbPath));
  const useDirectSourceOnly =
    (Boolean(sourceOptions.sourceType) && !hasExplicitConfigRequest) || shouldAutoloadCcSwitch;
  let configPath = null;
  let configDir = process.cwd();
  let config = null;

  if (useDirectSourceOnly) {
    config = buildDefaultSourceBackedConfig({
      sourceType: sourceOptions.sourceType ?? "cc-switch",
      sourceDbPath: sourceOptions.sourceDbPath,
      appType: appContext.appType,
    });
  } else {
    if (!configInspection.path) {
      if (configInspection.required) {
        throw new Error(`No pool config found. Checked: ${configInspection.candidates.join(", ")}`);
      }

      throw new Error(
        `No pool config or cc-switch database found. Checked configs: ${configInspection.candidates.join(", ")}. Expected default cc-switch db at ${defaultDbPath}. Install cc-switch and sign in first, or run with --pool-source-db FILE. Then run ${cliName} init.`,
      );
    }

    configPath = configInspection.path;
    configDir = path.dirname(configPath);
    config = await readConfigJson(configPath);
  }

  const configForInitialValidation = sourceOptions.sourceType && config.profileSource === undefined
    ? {
        ...config,
        profileSource: {
          type: sourceOptions.sourceType,
          ...(sourceOptions.sourceDbPath ? { dbPath: sourceOptions.sourceDbPath } : {}),
          ...(sourceOptions.appType ? { appType: sourceOptions.appType } : {}),
        },
      }
    : config;

  validatePoolConfig(configForInitialValidation, configPath ?? "<generated>", {
    allowSourceWithoutProfiles: true,
  });

  const materialized = await materializeProfileSource(config, configDir, sourceOptions);
  validatePoolConfig(materialized.config, configPath ?? "<generated>");

  return {
    configPath,
    configDir,
    config: materialized.config,
    metadata: materialized.metadata,
  };
}

function validateEnvObject(value, label) {
  if (value === undefined) {
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }

  for (const [key, envValue] of Object.entries(value)) {
    if (!key || typeof key !== "string" || !ENV_KEY_PATTERN.test(key)) {
      throw new Error(`${label} contains an invalid environment variable name: ${key}`);
    }

    const envType = typeof envValue;
    const allowed =
      envValue === null || envType === "string" || envType === "number" || envType === "boolean";

    if (!allowed) {
      throw new Error(
        `${label}.${key} must be a string, number, boolean, or null.`,
      );
    }
  }
}

export function getConfigStrategy(config) {
  return config.selection?.strategy ?? RANDOM_SELECTION_STRATEGY;
}

export function getCodexCommand(config) {
  return config.codexCommand || "codex";
}

export function findProfileByName(config, name) {
  return config.profiles.find((profile) => profile.name === name) ?? null;
}

export function pickProfile(config, options = {}) {
  const {
    profileName,
    random = Math.random,
  } = options;

  if (profileName) {
    const selected = findProfileByName(config, profileName);
    if (!selected) {
      throw new Error(`Unknown profile: ${profileName}`);
    }
    return selected;
  }

  const strategy = getConfigStrategy(config);
  if (strategy !== RANDOM_SELECTION_STRATEGY) {
    throw new Error(`Unsupported selection strategy: ${strategy}`);
  }

  const weights = config.profiles.map((profile) => profile.weight ?? 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const target = random() * totalWeight;
  let cursor = 0;

  for (let index = 0; index < config.profiles.length; index += 1) {
    cursor += weights[index];
    if (target < cursor) {
      return config.profiles[index];
    }
  }

  return config.profiles.at(-1);
}

export function resolvePathFromConfig(configDir, targetPath) {
  return path.resolve(configDir, expandHome(targetPath));
}
