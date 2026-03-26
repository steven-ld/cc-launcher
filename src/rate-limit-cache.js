import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolveAppContext } from "./app-context.js";
import { prepareCodexHome } from "./runtime-home.js";

const DEFAULT_CACHE_DIR = "~/.cc-launcher/cache";
const DEFAULT_CACHE_FILE = "rate-limits.json";
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMEOUT_MS = 15000;

const CLIENT_INFO = {
  name: "cc-launcher",
  title: "CC Launcher",
  version: "0.2.2",
};

function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return filePath;
  }
  if (filePath.startsWith("~/")) {
    return path.join(process.env.HOME || "", filePath.slice(2));
  }
  return filePath;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getFiveHourRemainingPercent(snapshot) {
  const windows = [snapshot?.primary, snapshot?.secondary].filter(isPlainObject);
  const fiveHourWindow = windows.find((window) => window.window_minutes === 300) ?? snapshot?.primary ?? null;
  const usedPercent = toFiniteNumber(fiveHourWindow?.used_percent);

  if (usedPercent === null) {
    return 0;
  }

  return Math.max(0, 100 - usedPercent);
}

async function ensureCacheDir(cacheDir) {
  const resolved = expandHome(cacheDir);
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  return resolved;
}

async function readCacheFile(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeCacheFile(cachePath, data) {
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
}

async function probeProfileRateLimit({ profile, configDir, codexCommand, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise(async (resolve, reject) => {
    // Use prepareCodexHome to properly set up runtime environment for this profile
    const { env: runtimeEnv } = await prepareCodexHome({
      configDir: configDir || os.homedir(),
      config: { sharedEnv: {}, runtimeRoot: "~/.cc-launcher/runtime" },
      profile,
      appType: "codex",
      baseEnv: process.env,
      writeFiles: true,
    });
    
    const child = spawn(codexCommand, ["app-server", "--listen", "stdio://"], {
      env: runtimeEnv,
      cwd: os.homedir(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map();
    const stderrChunks = [];
    let nextId = 1;
    let closed = false;

    const output = readline.createInterface({ input: child.stdout });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      output.close();
      child.stdin.end();
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      cleanup();
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (!closed) {
        clearTimeout(timeout);
        cleanup();
        if (pending.size > 0) {
          reject(new Error("Process exited before receiving rate limit response"));
        }
      }
    });

    output.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (!Object.prototype.hasOwnProperty.call(message, "id")) return;

      const entry = pending.get(message.id);
      if (!entry) return;

      clearTimeout(entry.timer);
      pending.delete(message.id);

      if (message.error) {
        entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
        return;
      }

      const snapshot = message.result?.rateLimitsByLimitId?.codex ?? message.result;
      if (!snapshot) {
        entry.reject(new Error("No rate limit data in response"));
        return;
      }

      entry.resolve(snapshot);
    });

    const sendRequest = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej, timer: setTimeout(() => {
        pending.delete(id);
        rej(new Error(`Request ${method} timed out`));
      }, timeoutMs) });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });

    (async () => {
      try {
        await sendRequest("initialize", {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true },
        });
        // Send initialized as a notification (no id)
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        const result = await sendRequest("account/rateLimits/read");
        clearTimeout(timeout);
        cleanup();
        resolve(result);
      } catch (error) {
        clearTimeout(timeout);
        cleanup();
        reject(error);
      }
    })();
  });
}

export class RateLimitCache {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.codexCommand = options.codexCommand ?? "codex";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.configDir = options.configDir ?? os.homedir();

    this.cache = null;
    this.refreshTimer = null;
    this.isRefreshing = false;
    this.listeners = new Set();
  }

  getCacheFilePath() {
    return path.join(expandHome(this.cacheDir), DEFAULT_CACHE_FILE);
  }

  async load() {
    const cachePath = this.getCacheFilePath();
    this.cache = await readCacheFile(cachePath);
    return this.cache;
  }

  async save() {
    await ensureCacheDir(this.cacheDir);
    const cachePath = this.getCacheFilePath();
    await writeCacheFile(cachePath, this.cache);
  }

  async refreshProfiles(profiles) {
    if (this.isRefreshing) {
      return this.cache;
    }

    this.isRefreshing = true;
    const results = [];
    const errors = [];

    for (const profile of profiles) {
      // Only probe official profiles with auth
      if (!profile.auth && !profile.authFile) {
        continue;
      }

      try {
        const snapshot = await probeProfileRateLimit({
          profile,
          configDir: this.configDir || os.homedir(),
          codexCommand: this.codexCommand,
          timeoutMs: this.timeoutMs,
        });

        results.push({
          profileName: profile.name,
          snapshot: {
            primary: {
              used_percent: snapshot.primary?.usedPercent ?? snapshot.primary?.used_percent ?? 0,
              window_minutes: snapshot.primary?.windowDurationMins ?? snapshot.primary?.window_minutes ?? 300,
              resets_at: snapshot.primary?.resetsAt ?? snapshot.primary?.resets_at ?? null,
            },
            secondary: {
              used_percent: snapshot.secondary?.usedPercent ?? snapshot.secondary?.used_percent ?? 0,
              window_minutes: snapshot.secondary?.windowDurationMins ?? snapshot.secondary?.window_minutes ?? 10080,
              resets_at: snapshot.secondary?.resetsAt ?? snapshot.secondary?.resets_at ?? null,
            },
            plan_type: snapshot.plan_type ?? "unknown",
          },
          updatedAt: Date.now(),
        });
      } catch (error) {
        errors.push({
          profileName: profile.name,
          error: error.message,
        });
      }
    }

    this.cache = {
      version: 1,
      updatedAt: Date.now(),
      profiles: results,
      errors,
    };

    try {
      await this.save();
    } catch (error) {
      // Non-fatal: cache write failed
    }

    this.isRefreshing = false;

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(this.cache);
      } catch {
        // Ignore listener errors
      }
    }

    return this.cache;
  }

  startBackgroundRefresh(profiles) {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Initial refresh
    this.refreshProfiles(profiles).catch(() => {});

    // Schedule periodic refresh
    this.refreshTimer = setInterval(() => {
      this.refreshProfiles(profiles).catch(() => {});
    }, this.refreshIntervalMs);

    return this.refreshTimer;
  }

  stopBackgroundRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getProfileWithMostRemaining() {
    if (!this.cache?.profiles || this.cache.profiles.length === 0) {
      return null;
    }

    let best = null;
    let bestRemaining = -1;

    for (const entry of this.cache.profiles) {
      const remaining = getFiveHourRemainingPercent(entry.snapshot);
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        best = entry;
      }
    }

    return best;
  }

  getSortedProfiles() {
    if (!this.cache?.profiles || this.cache.profiles.length === 0) {
      return [];
    }

    return [...this.cache.profiles]
      .map((entry) => ({
        ...entry,
        remaining5hPercent: getFiveHourRemainingPercent(entry.snapshot),
      }))
      .sort((a, b) => b.remaining5hPercent - a.remaining5hPercent);
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus() {
    return {
      hasCache: this.cache !== null,
      isRefreshing: this.isRefreshing,
      profileCount: this.cache?.profiles?.length ?? 0,
      updatedAt: this.cache?.updatedAt ?? null,
      errorCount: this.cache?.errors?.length ?? 0,
    };
  }
}

// Singleton instance
let globalCache = null;

export function getRateLimitCache(options = {}) {
  if (!globalCache) {
    globalCache = new RateLimitCache(options);
  }
  return globalCache;
}
