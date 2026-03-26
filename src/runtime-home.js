import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveAppContext } from "./app-context.js";
import { resolvePathFromConfig } from "./pool-config.js";

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const GLOBAL_CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const DEFAULT_SHARED_HOME_ENTRIES = [
  "AGENTS.md",
  "skills",
  "prompts",
  "rules",
];
const CLAUDE_PROVIDER_ENV_PREFIXES = ["ANTHROPIC_"];

function sanitizeProfileName(profileName) {
  return profileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeSecureFile(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`Failed to remove ${filePath}: ${error.message}`);
  }
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function resolveRuntimeRoot(configDir, config) {
  return config.runtimeRoot
    ? resolvePathFromConfig(configDir, config.runtimeRoot)
    : path.resolve(configDir, ".runtime");
}

function resolveRuntimeHome(configDir, config, profile, appContext) {
  const runtimeHomeEnvKey = appContext.runtimeHomeEnvKey;
  const rawRuntimeHome = runtimeHomeEnvKey ? profile.env?.[runtimeHomeEnvKey] : undefined;
  if (typeof rawRuntimeHome === "string" && rawRuntimeHome.trim()) {
    return resolvePathFromConfig(configDir, rawRuntimeHome);
  }

  return path.join(resolveRuntimeRoot(configDir, config), sanitizeProfileName(profile.name));
}

function resolveSharedCodexHome(configDir, config, appContext) {
  return config.sharedCodexHome
    ? resolvePathFromConfig(configDir, config.sharedCodexHome)
    : resolvePathFromConfig(configDir, appContext.sharedHome);
}

function getSharedHomeEntries(config) {
  return config.sharedHomeEntries ?? DEFAULT_SHARED_HOME_ENTRIES;
}

async function loadAuthPayload(configDir, profile) {
  if (profile.auth !== undefined) {
    return JSON.stringify(profile.auth, null, 2);
  }

  if (profile.authFile) {
    const authFilePath = resolvePathFromConfig(configDir, profile.authFile);
    return fs.readFile(authFilePath, "utf8");
  }

  return null;
}

async function loadConfigToml(configDir, config, profile, appContext) {
  if (profile.configToml !== undefined) {
    return profile.configToml;
  }

  if (profile.configTomlFile) {
    const profileConfigPath = resolvePathFromConfig(configDir, profile.configTomlFile);
    return fs.readFile(profileConfigPath, "utf8");
  }

  if (config.sharedConfigToml !== undefined) {
    return config.sharedConfigToml;
  }

  if (config.sharedConfigTomlFile) {
    const sharedConfigPath = resolvePathFromConfig(configDir, config.sharedConfigTomlFile);
    return fs.readFile(sharedConfigPath, "utf8");
  }

  const inheritGlobalConfig = config.inheritGlobalConfig ?? true;
  if (appContext.appType === "codex" && inheritGlobalConfig && (await fileExists(GLOBAL_CONFIG_PATH))) {
    return fs.readFile(GLOBAL_CONFIG_PATH, "utf8");
  }

  return null;
}

function applyEnvLayer(target, envLayer) {
  if (!envLayer) {
    return target;
  }

  for (const [key, value] of Object.entries(envLayer)) {
    if (value === null) {
      delete target[key];
    } else {
      target[key] = String(value);
    }
  }

  return target;
}

function mergeManagedEnv(config, profile) {
  const env = {};
  applyEnvLayer(env, config.sharedEnv);
  applyEnvLayer(env, profile.env);
  // Strip ANTHROPIC_BASE_URL so the spawned CLI routes through the cc-launcher
  // proxy (127.0.0.1:15722) instead of connecting upstream directly.
  // The proxy resolves the upstream target from profile.sourceMeta.upstreamUrl.
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

function stripClaudeProviderEnv(env) {
  const filtered = {};

  for (const [key, value] of Object.entries(env)) {
    if (CLAUDE_PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    filtered[key] = value;
  }

  return filtered;
}

async function loadJsonObjectIfExists(filePath, label) {
  if (!(await fileExists(filePath))) {
    return null;
  }

  const raw = await fs.readFile(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error("must be a JSON object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${label} ${filePath}: ${error.message}`);
  }
}

async function buildManagedSettingsPayload(config, profile, appContext) {
  if (appContext.appType !== "claude") {
    return null;
  }

  const baseSettings = (await loadJsonObjectIfExists(GLOBAL_CLAUDE_SETTINGS_PATH, "Claude settings")) ?? {};
  const baseEnv = isPlainObject(baseSettings.env) ? stripClaudeProviderEnv(baseSettings.env) : {};
  const env = applyEnvLayer(baseEnv, mergeManagedEnv(config, profile));
  // mergeManagedEnv strips ANTHROPIC_BASE_URL from the spawned process env so that
  // cclaude routes through the cc-launcher proxy.  Restore it here so that it appears
  // in settings.json -- the proxy server will still intercept the request and forward
  // it to the correct upstream based on profile.sourceMeta.upstreamUrl.
  // Restore ANTHROPIC_BASE_URL so cclaude reads the upstream target from settings.json.
  // For cc-switch profiles this comes from sourceMeta.upstreamUrl; for static profiles
  // it comes directly from profile.env.
  const upstreamUrl = profile.sourceMeta?.upstreamUrl ?? profile.env?.ANTHROPIC_BASE_URL;
  if (upstreamUrl) {
    env.ANTHROPIC_BASE_URL = upstreamUrl;
  }
  const settings = { ...baseSettings };

  // Let the selected provider env decide the effective model instead of a global pinned user model.
  delete settings.model;

  if (Object.keys(env).length > 0) {
    settings.env = env;
  } else {
    delete settings.env;
  }

  return settings;
}

function mergeEnv(baseEnv, config, profile, runtimeHome, appContext) {
  const merged = { ...baseEnv };
  applyEnvLayer(merged, config.sharedEnv);
  applyEnvLayer(merged, profile.env);

  if (appContext.runtimeHomeEnvKey) {
    merged[appContext.runtimeHomeEnvKey] = runtimeHome;
  }
  // Strip ANTHROPIC_BASE_URL so the spawned CLI routes through the cc-launcher
  // proxy instead of connecting upstream directly.
  delete merged.ANTHROPIC_BASE_URL;
  return merged;
}

async function syncSharedEntry(sourcePath, targetPath, isDirectory) {
  if (await isSymlinkToTarget(targetPath, sourcePath)) {
    return;
  }

  await removeIfExists(targetPath);

  try {
    await fs.symlink(sourcePath, targetPath, isDirectory ? "dir" : "file");
  } catch {
    await fs.cp(sourcePath, targetPath, { recursive: isDirectory, force: true });
  }
}

async function isSymlinkToTarget(targetPath, expectedSourcePath) {
  try {
    const stat = await fs.lstat(targetPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }

    const actualSourcePath = await fs.readlink(targetPath);
    const resolvedSourcePath = path.resolve(path.dirname(targetPath), actualSourcePath);
    return resolvedSourcePath === expectedSourcePath;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function syncSharedHomeEntries(configDir, config, runtimeHome, appContext) {
  const sharedCodexHome = resolveSharedCodexHome(configDir, config, appContext);

  for (const entry of getSharedHomeEntries(config)) {
    const sourcePath = path.join(sharedCodexHome, entry);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const sourceStat = await fs.lstat(sourcePath);
    const targetPath = path.join(runtimeHome, entry);
    await syncSharedEntry(sourcePath, targetPath, sourceStat.isDirectory());
  }
}

export async function prepareCodexHome({
  configDir,
  config,
  profile,
  appType = "codex",
  baseEnv = process.env,
  writeFiles = true,
}) {
  const appContext = resolveAppContext(appType);
  const runtimeHome = resolveRuntimeHome(configDir, config, profile, appContext);
  const sharedCodexHome = resolveSharedCodexHome(configDir, config, appContext);
  const authJsonPath = path.join(runtimeHome, "auth.json");
  const configTomlPath = path.join(runtimeHome, "config.toml");
  const settingsJsonPath = path.join(runtimeHome, "settings.json");

  if (appContext.runtimeHomeEnvKey && runtimeHome === sharedCodexHome) {
    throw new Error(
      `Profile ${profile.name} resolves ${appContext.runtimeHomeEnvKey} to the shared home ${sharedCodexHome}. Use an isolated directory.`,
    );
  }

  if (writeFiles) {
    await ensureDirectory(runtimeHome);
    if (appContext.runtimeHomeEnvKey) {
      await syncSharedHomeEntries(configDir, config, runtimeHome, appContext);
    }

    const [authPayload, configTomlPayload, settingsPayload] = await Promise.all([
      loadAuthPayload(configDir, profile),
      loadConfigToml(configDir, config, profile, appContext),
      buildManagedSettingsPayload(config, profile, appContext),
    ]);

    if (authPayload !== null) {
      await writeSecureFile(authJsonPath, authPayload.endsWith("\n") ? authPayload : `${authPayload}\n`);
    } else {
      await removeIfExists(authJsonPath);
    }

    if (configTomlPayload !== null) {
      await writeSecureFile(
        configTomlPath,
        configTomlPayload.endsWith("\n") ? configTomlPayload : `${configTomlPayload}\n`,
      );
    } else {
      await removeIfExists(configTomlPath);
    }

    if (settingsPayload !== null) {
      await writeSecureFile(settingsJsonPath, `${JSON.stringify(settingsPayload, null, 2)}\n`);
    } else {
      await removeIfExists(settingsJsonPath);
    }
  }

  const env = mergeEnv(baseEnv, config, profile, runtimeHome, appContext);

  return {
    runtimeHome,
    authJsonPath,
    configTomlPath,
    settingsJsonPath,
    env,
  };
}
