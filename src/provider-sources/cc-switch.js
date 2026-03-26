import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_CC_SWITCH_DB_PATH = "~/.cc-switch/cc-switch.db";

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(rawValue, label) {
  if (!rawValue) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${error.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed;
}

function trimToUndefined(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function mergeTomlFragments(fragments) {
  const normalized = fragments
    .map((fragment) => trimToUndefined(fragment))
    .filter(Boolean);

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.join("\n\n");
}

function normalizeEnv(env) {
  if (!isPlainObject(env) || Object.keys(env).length === 0) {
    return undefined;
  }

  return env;
}

function hasImportableAuth(auth) {
  if (!isPlainObject(auth)) {
    return false;
  }

  if (trimToUndefined(auth.OPENAI_API_KEY)) {
    return true;
  }

  if (trimToUndefined(auth.auth_mode)) {
    return true;
  }

  const tokens = auth.tokens;
  if (!isPlainObject(tokens)) {
    return false;
  }

  return Boolean(
    trimToUndefined(tokens.account_id) ||
      trimToUndefined(tokens.access_token) ||
      trimToUndefined(tokens.refresh_token) ||
      trimToUndefined(tokens.id_token),
  );
}

function hasImportableProfileState({ auth, env }) {
  return hasImportableAuth(auth) || Boolean(normalizeEnv(env));
}

function shortStableId(value, fallback) {
  const source = trimToUndefined(value) || fallback;
  return String(source).slice(0, 8).toLowerCase();
}

export function resolveCcSwitchDbPath(dbPath = DEFAULT_CC_SWITCH_DB_PATH) {
  return path.resolve(expandHome(dbPath));
}

export function buildCcSwitchStableProfileName({ appType = "codex", providerId, accountId }) {
  const accountPart = shortStableId(accountId, "noaccount");
  const providerPart = shortStableId(providerId, "provider");
  return `${appType}-${accountPart}-${providerPart}`;
}

export function materializeCcSwitchCodexProfile({
  provider,
  commonConfigToml,
  appType = "codex",
}) {
  if (!provider || typeof provider !== "object") {
    throw new Error("provider is required.");
  }

  const settingsConfig = parseJsonObject(provider.settings_config, `providers(${provider.id}).settings_config`);
  const meta = parseJsonObject(provider.meta, `providers(${provider.id}).meta`);
  const auth = isPlainObject(settingsConfig.auth) ? settingsConfig.auth : undefined;
  const accountId = auth?.tokens?.account_id ?? null;
  const env = normalizeEnv(settingsConfig.env);
  const configToml = mergeTomlFragments([
    meta.commonConfigEnabled ? commonConfigToml : undefined,
    settingsConfig.config,
  ]);

  const profile = {
    name: buildCcSwitchStableProfileName({
      appType,
      providerId: provider.id,
      accountId,
    }),
    weight: 1,
    sourceMeta: {
      type: "cc-switch",
      providerId: provider.id,
      appType,
      providerName: provider.name,
      accountId,
      isCurrent: Boolean(provider.is_current),
      commonConfigEnabled: Boolean(meta.commonConfigEnabled),
    },
  };

  if (auth !== undefined) {
    profile.auth = auth;
  }

  if (configToml !== undefined) {
    profile.configToml = configToml;
  }

  if (env !== undefined) {
    profile.env = env;
  }

  return profile;
}

export function loadCcSwitchSource(options = {}) {
  return readCcSwitchCodexProfiles(options);
}

export function readCcSwitchCodexProfiles(options = {}) {
  const {
    dbPath = DEFAULT_CC_SWITCH_DB_PATH,
    appType = "codex",
    includeIncomplete = false,
  } = options;

  const resolvedDbPath = resolveCcSwitchDbPath(dbPath);
  const database = new DatabaseSync(resolvedDbPath, { open: true, readOnly: true });

  try {
    const providers = database
      .prepare(
        `SELECT id, app_type, name, settings_config, meta, is_current
         FROM providers
         WHERE app_type = ?
         ORDER BY sort_index ASC, name ASC, id ASC`,
      )
      .all(appType);

    const commonConfigRow = database
      .prepare(`SELECT value FROM settings WHERE key = ? LIMIT 1`)
      .get(`common_config_${appType}`);
    const commonConfigToml = trimToUndefined(commonConfigRow?.value);

    const profiles = [];
    const importedProviderIds = [];
    const skippedProviders = [];

    for (const provider of providers) {
      const settingsConfig = parseJsonObject(provider.settings_config, `providers(${provider.id}).settings_config`);
      const auth = isPlainObject(settingsConfig.auth) ? settingsConfig.auth : undefined;
      const env = normalizeEnv(settingsConfig.env);
      const accountId = auth?.tokens?.account_id ?? null;

      if (!includeIncomplete && !hasImportableProfileState({ auth, env })) {
        skippedProviders.push({
          providerId: provider.id,
          providerName: provider.name,
          appType,
          accountId,
          reason: "missing_profile_state",
        });
        continue;
      }

      profiles.push(
        materializeCcSwitchCodexProfile({
          provider,
          commonConfigToml,
          appType,
        }),
      );
      importedProviderIds.push(provider.id);
    }

    return {
      profiles,
      metadata: {
        source: {
          type: "cc-switch",
          appType,
          dbPath: resolvedDbPath,
        },
        commonConfigToml,
        providerCount: providers.length,
        importedProviderIds,
        skippedProviders,
      },
    };
  } finally {
    database.close();
  }
}
