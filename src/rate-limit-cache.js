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
const DEFAULT_TIMEOUT_MS = 15_000;

// --- CC Cloud: patterns that indicate a "model error" (provider returned error, not our fault) ---
const CC_CLOUD_MODEL_ERROR_PATTERNS = [
  /model.*not.*found/i,
  /model.*not.*support/i,
  /unsupported.*model/i,
  /invalid.*model/i,
  /model.*unavailable/i,
  /quota.*exceeded/i,
  /rate.*limit.*exceeded/i,
  /rate_limit_exceeded/i,
  /429/i,
  /too.*many.*requests/i,
  /context.*length.*exceeded/i,
  /max.*tokens.*exceeded/i,
  /token.*limit/i,
  /billing.*error/i,
  /payment.*required/i,
  /api.*key.*invalid/i,
  /invalid.*api.*key/i,
  /authentication.*failed/i,
  /auth.*fail/i,
  /permission.*denied/i,
  /forbidden/i,
  /access.*denied/i,
  /upstream.*error/i,
  /server.*error/i,
  /internal.*error/i,
  /bad.*gateway/i,
  /service.*unavailable/i,
  /gateway.*timeout/i,
  /502/i,
  /503/i,
  /504/i,
  // Generic error markers (provider returned a structured error)
  /"error"\s*:/i,
  /"errorCode"\s*:/i,
  /error_message/i,
];

const CLIENT_INFO = {
  name: "cc-launcher",
  title: "CC Launcher",
  version: "0.2.2",
};

// --- Structured probe error ---
export class ProbeError extends Error {
  /**
   * @param {string} message
   * @param {"auth" | "timeout" | "network" | "model_error" | "protocol" | "unknown"} kind
   * @param {Record<string, unknown>} [extra]
   */
  constructor(message, kind = "unknown", extra = {}) {
    super(message);
    this.name = "ProbeError";
    this.kind = kind;
    Object.assign(this, extra);
  }

  toString() {
    return `[${this.kind}] ${this.message}`;
  }
}

function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
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
  const fiveHourWindow = windows.find((w) => w.window_minutes === 300) ?? snapshot?.primary ?? null;
  const usedPercent = toFiniteNumber(fiveHourWindow?.used_percent);
  if (usedPercent === null) return 0;
  return Math.max(0, 100 - usedPercent);
}

async function ensureCacheDir(cacheDir) {
  const resolved = expandHome(cacheDir);
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return resolved;
}

async function readCacheFile(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCacheFile(cachePath, data) {
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Determine if a text contains a CC Cloud "model error".
 * Returns true if the response body contains one of the model error patterns.
 */
function containsModelError(text) {
  return CC_CLOUD_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify a raw error thrown during probe into a ProbeError kind.
 */
function classifyError(error) {
  const message = error.message ?? String(error);
  const lowered = message.toLowerCase();

  if (
    /authentication.*fail|auth.*fail|invalid.*token|token.*expired|401|unauthorized|credentials.*expired/i.test(
      lowered,
    )
  ) {
    return new ProbeError(message, "auth");
  }
  if (/timeout|timed?\s*out|etimedout|esockettimedout/i.test(lowered)) {
    return new ProbeError(message, "timeout");
  }
  if (/econnrefused|ehostunreach|enetunreach|eai_again|network/i.test(lowered)) {
    return new ProbeError(message, "network");
  }
  return new ProbeError(message, "unknown");
}

// ─── CC Cloud probe ─────────────────────────────────────────────────────────
//
// "能用" = 1) 请求成功发出并收到 HTTP 响应  2) 响应体内不含模型错误
// 不探测额度，只探测连通性和错误响应
//
async function probeCcCloudProfile({ profile, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const baseUrl =
    profile.env?.ANTHROPIC_BASE_URL ??
    profile.sourceMeta?.upstreamUrl ??
    "https://api.anthropic.com";

  const apiKey =
    profile.env?.ANTHROPIC_API_KEY ??
    profile.env?.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey) {
    throw new ProbeError(
      `Profile ${profile.name} has no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN`,
      "auth",
    );
  }

  const url = `${baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"}v1/messages`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let rawBody = "";
  let httpStatus = 0;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022", // lightweight model for probe
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    httpStatus = response.status;

    // Read response body for error pattern detection
    rawBody = await response.text();

    // CC Cloud 可用判断：HTTP 2xx 且无模型错误
    if (response.ok && !containsModelError(rawBody)) {
      return {
        usable: true,
        httpStatus,
        snapshot: null, // CC Cloud 不返回额度
      };
    }

    // 有错误内容
    if (containsModelError(rawBody)) {
      return {
        usable: false,
        httpStatus,
        reason: "model_error",
        rawBody: rawBody.slice(0, 500),
      };
    }

    // 2xx 但有未知内容 → 保守认为可用
    return { usable: true, httpStatus, snapshot: null };
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new ProbeError(`Probe timed out after ${timeoutMs}ms`, "timeout", {
        profile: profile.name,
      });
    }
    throw classifyError(error);
  }
}

// ─── Codex probe (original quota-based logic) ───────────────────────────────
async function probeCodexProfile({ profile, configDir, codexCommand, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise(async (resolve, reject) => {
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
    let closed = false;
    let nextId = 1;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      output.close();
      child.stdin.end();
      if (!child.killed) child.kill("SIGTERM");
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new ProbeError(`Probe timed out after ${timeoutMs}ms`, "timeout", {
          profile: profile.name,
        }),
      );
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      cleanup();
      reject(classifyError(error));
    });

    child.on("exit", (code, signal) => {
      if (!closed) {
        clearTimeout(timeout);
        cleanup();
        if (pending.size > 0) {
          reject(
            new ProbeError(
              `app-server(${profile.name}) exited unexpectedly (${code ?? signal ?? "unknown"})`,
              "protocol",
            ),
          );
        }
      }
    });

    const output = readline.createInterface({ input: child.stdout });

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
        const raw = JSON.stringify(message.error);
        const kind = /auth|token|unauthorized|invalid.*credential/i.test(raw) ? "auth" : "model_error";
        reject(new ProbeError(raw, kind, { profile: profile.name }));
        return;
      }

      const snapshot = message.result?.rateLimitsByLimitId?.codex ?? message.result;
      if (!snapshot) {
        reject(new ProbeError("No rate limit data in response", "protocol"));
        return;
      }

      clearTimeout(timeout);
      cleanup();
      resolve(snapshot);
    });

    const sendRequest = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, {
          resolve: res,
          reject: rej,
          timer: setTimeout(() => {
            pending.delete(id);
            rej(new ProbeError(`Request ${method} timed out`, "timeout"));
          }, timeoutMs),
        });
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      });

    (async () => {
      try {
        await sendRequest("initialize", {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true },
        });
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        const result = await sendRequest("account/rateLimits/read");
        clearTimeout(timeout);
        cleanup();
        resolve(result);
      } catch (error) {
        clearTimeout(timeout);
        cleanup();
        reject(classifyError(error));
      }
    })();
  });
}

// ─── Unified probe entry ────────────────────────────────────────────────────
export async function probeProfile({ profile, configDir, codexCommand, appType = "codex", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (appType === "claude") {
    return probeCcCloudProfile({ profile, timeoutMs });
  }
  return probeCodexProfile({ profile, configDir, codexCommand, timeoutMs });
}

// ─── RateLimitCache ─────────────────────────────────────────────────────────
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

  /**
   * Refresh all profiles.
   * For claude/cc-cloud profiles: checks usability only.
   * For codex profiles: fetches quota.
   */
  async refreshProfiles(profiles, options = {}) {
    if (this.isRefreshing && !options.force) {
      return this.cache;
    }

    this.isRefreshing = true;
    const results = [];
    const errors = [];

    for (const profile of profiles) {
      // Skip non-official profiles in refresh
      if (!profile.auth && !profile.authFile && !profile.env?.ANTHROPIC_API_KEY && !profile.env?.ANTHROPIC_AUTH_TOKEN) {
        continue;
      }

      try {
        const result = await probeProfile({
          profile,
          configDir: this.configDir,
          codexCommand: this.codexCommand,
          appType: options.appType ?? "codex",
          timeoutMs: this.timeoutMs,
        });

        if (options.appType === "claude" || options.appType === "cc-cloud") {
          // CC Cloud: usable flag + raw info
          results.push({
            profileName: profile.name,
            usable: result.usable,
            httpStatus: result.httpStatus ?? null,
            reason: result.reason ?? null,
            updatedAt: Date.now(),
          });
        } else {
          // Codex: quota snapshot
          results.push({
            profileName: profile.name,
            snapshot: {
              primary: {
                used_percent: result.primary?.usedPercent ?? result.primary?.used_percent ?? 0,
                window_minutes: result.primary?.windowDurationMins ?? result.primary?.window_minutes ?? 300,
                resets_at: result.primary?.resetsAt ?? result.primary?.resets_at ?? null,
              },
              secondary: {
                used_percent: result.secondary?.usedPercent ?? result.secondary?.used_percent ?? 0,
                window_minutes: result.secondary?.windowDurationMins ?? result.secondary?.window_minutes ?? 10080,
                resets_at: result.secondary?.resetsAt ?? result.secondary?.resets_at ?? null,
              },
              plan_type: result.plan_type ?? "unknown",
            },
            updatedAt: Date.now(),
          });
        }
      } catch (error) {
        const kind = error instanceof ProbeError ? error.kind : "unknown";
        errors.push({
          profileName: profile.name,
          kind,
          message: error instanceof Error ? error.message : String(error),
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
    } catch {
      // Non-fatal
    }

    this.isRefreshing = false;

    for (const listener of this.listeners) {
      try {
        listener(this.cache);
      } catch {
        // Ignore listener errors
      }
    }

    return this.cache;
  }

  startBackgroundRefresh(profiles, options = {}) {
    if (this.refreshTimer) clearInterval(this.refreshTimer);

    // Initial refresh
    this.refreshProfiles(profiles, options).catch(() => {});

    this.refreshTimer = setInterval(() => {
      this.refreshProfiles(profiles, options).catch(() => {});
    }, this.refreshIntervalMs);

    return this.refreshTimer;
  }

  stopBackgroundRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getBestUsableProfile() {
    if (!this.cache?.profiles || this.cache.profiles.length === 0) return null;

    let best = null;
    let bestRemaining = -1;

    for (const entry of this.cache.profiles) {
      if (entry.usable === false) continue; // skip unusable
      const remaining =
        entry.remaining5hPercent ??
        (entry.usable === true ? 100 : 0);
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        best = entry;
      }
    }

    return best;
  }

  getProfileWithMostRemaining() {
    if (!this.cache?.profiles || this.cache.profiles.length === 0) return null;

    let best = null;
    let bestRemaining = -1;

    for (const entry of this.cache.profiles) {
      // Skip entries without a snapshot (e.g. CC Cloud usable-only entries)
      if (!entry.snapshot) continue;
      const remaining = getFiveHourRemainingPercent(entry.snapshot);
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        best = entry;
      }
    }

    return best;
  }

  getSortedProfiles() {
    if (!this.cache?.profiles || this.cache.profiles.length === 0) return [];

    return [...this.cache.profiles]
      .map((entry) => ({
        ...entry,
        remaining5hPercent:
          entry.snapshot ? getFiveHourRemainingPercent(entry.snapshot) : null,
      }))
      .sort((a, b) => {
        // CC Cloud: sort by usable first, then by name
        if ("usable" in a && "usable" in b) {
          if (a.usable !== b.usable) return a.usable ? -1 : 1;
          return 0;
        }
        // Codex: sort by remaining
        const remA = a.remaining5hPercent ?? 0;
        const remB = b.remaining5hPercent ?? 0;
        return remB - remA;
      });
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

// ─── Multi-instance cache registry (fixes P0-2) ────────────────────────────
// Cache instances keyed by configDir so different working directories
// don't share cache state.
const instances = new Map();

export function getRateLimitCache(options = {}) {
  const key = options.configDir ?? os.homedir();
  if (!instances.has(key)) {
    instances.set(key, new RateLimitCache(options));
  }
  return instances.get(key);
}
