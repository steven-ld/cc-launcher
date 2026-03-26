import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MANAGED_STATE_FILENAME = ".cc-launcher-managed.json";

function sanitizeRuntimeDirName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function normalizeManagedProfiles(profiles) {
  return profiles.map((profile) => ({
    key: String(profile.key),
    runtimeDirName: sanitizeRuntimeDirName(profile.runtimeDirName),
    name: String(profile.name || profile.runtimeDirName),
  }));
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
}

async function writeSecureFile(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isSafeChildPath(parentDir, childName) {
  if (!childName || childName === "." || childName === "..") {
    return false;
  }

  const resolved = path.resolve(parentDir, childName);
  return resolved.startsWith(`${path.resolve(parentDir)}${path.sep}`);
}

export function resolveManagedStatePath(runtimeRoot, stateFileName = DEFAULT_MANAGED_STATE_FILENAME) {
  return path.join(runtimeRoot, stateFileName);
}

export async function readManagedProfileState(runtimeRoot, stateFileName = DEFAULT_MANAGED_STATE_FILENAME) {
  const statePath = resolveManagedStatePath(runtimeRoot, stateFileName);
  const payload = await readJsonIfExists(statePath);

  if (!payload) {
    return {
      version: 1,
      sourceType: null,
      profiles: [],
    };
  }

  return {
    version: payload.version ?? 1,
    sourceType: payload.sourceType ?? null,
    profiles: Array.isArray(payload.profiles) ? payload.profiles : [],
  };
}

export async function writeManagedProfileState({
  runtimeRoot,
  sourceType,
  profiles,
  stateFileName = DEFAULT_MANAGED_STATE_FILENAME,
}) {
  await ensureDirectory(runtimeRoot);
  const statePath = resolveManagedStatePath(runtimeRoot, stateFileName);
  const payload = {
    version: 1,
    sourceType,
    profiles: normalizeManagedProfiles(profiles),
    updatedAt: new Date().toISOString(),
  };

  await writeSecureFile(statePath, `${JSON.stringify(payload, null, 2)}\n`);
  return statePath;
}

export async function pruneManagedRuntimeHomes({
  runtimeRoot,
  sourceType,
  profiles,
  stateFileName = DEFAULT_MANAGED_STATE_FILENAME,
}) {
  const previous = await readManagedProfileState(runtimeRoot, stateFileName);
  const nextProfiles = normalizeManagedProfiles(profiles);
  const nextKeys = new Set(nextProfiles.map((profile) => profile.key));

  if (previous.sourceType === sourceType) {
    for (const profile of previous.profiles) {
      if (nextKeys.has(profile.key)) {
        continue;
      }

      if (!isSafeChildPath(runtimeRoot, profile.runtimeDirName)) {
        continue;
      }

      const stalePath = path.join(runtimeRoot, profile.runtimeDirName);
      await fs.rm(stalePath, { recursive: true, force: true });
    }
  }

  return writeManagedProfileState({
    runtimeRoot,
    sourceType,
    profiles: nextProfiles,
    stateFileName,
  });
}
