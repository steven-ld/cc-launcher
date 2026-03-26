import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const CLIENT_INFO = {
  name: "cc-launcher",
  title: "CC Launcher",
  version: "0.1.0",
};

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT_ID = "codex";
const TOKEN_COUNT_EVENT_TYPE = "token_count";

function createTimeout(label, timeoutMs, onTimeout) {
  return setTimeout(() => {
    onTimeout(new Error(`${label} timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
}

function buildRequest(id, method, params) {
  const request = { method, id };
  if (params !== undefined) {
    request.params = params;
  }
  return request;
}

function buildNotification(method, params) {
  const notification = { method };
  if (params !== undefined) {
    notification.params = params;
  }
  return notification;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRateLimitWindow(window) {
  if (!isPlainObject(window)) {
    return null;
  }

  return {
    used_percent: window.used_percent ?? window.usedPercent ?? null,
    window_minutes: window.window_minutes ?? window.windowDurationMins ?? null,
    resets_at: window.resets_at ?? window.resetsAt ?? null,
  };
}

function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeRateLimitSnapshot(payload) {
  const snapshot = payload?.rateLimitsByLimitId?.[DEFAULT_LIMIT_ID]
    ?? payload?.rateLimits
    ?? payload;

  if (!isPlainObject(snapshot)) {
    throw new Error("Rate limit snapshot is missing from the server response.");
  }

  const normalized = {
    limit_id: snapshot.limit_id ?? snapshot.limitId ?? null,
    limit_name: snapshot.limit_name ?? snapshot.limitName ?? null,
    primary: normalizeRateLimitWindow(snapshot.primary),
    secondary: normalizeRateLimitWindow(snapshot.secondary),
    credits: snapshot.credits ?? null,
    plan_type: snapshot.plan_type ?? snapshot.planType ?? null,
  };

  if (!isPlainObject(normalized.primary) || !isPlainObject(normalized.secondary)) {
    throw new Error("Rate limit snapshot is missing primary or secondary windows.");
  }

  return normalized;
}

export function getFiveHourRemainingPercent(snapshot) {
  const windows = [snapshot?.primary, snapshot?.secondary].filter(isPlainObject);
  const fiveHourWindow = windows.find((window) => window.window_minutes === 300) ?? snapshot?.primary ?? null;
  const usedPercent = toFiniteNumber(fiveHourWindow?.used_percent);

  if (usedPercent === null) {
    throw new Error("5h rate limit usage is missing from the snapshot.");
  }

  return Math.max(0, 100 - usedPercent);
}

function getWindowLabel(windowMinutes) {
  if (windowMinutes === 300) {
    return "5h";
  }

  if (windowMinutes === 10080) {
    return "1w";
  }

  if (typeof windowMinutes !== "number") {
    return "unknown";
  }

  if (windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d`;
  }

  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }

  return `${windowMinutes}m`;
}

function formatResetTime(unixSeconds) {
  if (typeof unixSeconds !== "number") {
    return "unknown";
  }

  return new Date(unixSeconds * 1000).toLocaleString();
}

export function formatUsageReport({ profileName, snapshot, source }) {
  const lines = [
    `profile: ${profileName}`,
    `source: ${source}`,
  ];

  if (snapshot.limit_id) {
    lines.push(`limit_id: ${snapshot.limit_id}`);
  }

  if (snapshot.plan_type) {
    lines.push(`plan: ${snapshot.plan_type}`);
  }

  for (const [label, window] of [
    [getWindowLabel(snapshot.primary?.window_minutes ?? null), snapshot.primary],
    [getWindowLabel(snapshot.secondary?.window_minutes ?? null), snapshot.secondary],
  ]) {
    lines.push(
      `${label}: ${window.used_percent}% used, resets at ${formatResetTime(window.resets_at)}`,
    );
  }

  return lines.join("\n");
}

async function createAppServerSession({
  codexCommand,
  env,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess = spawn,
}) {
  const child = spawnProcess(codexCommand, ["app-server", "--listen", "stdio://"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  const stderrChunks = [];
  let nextId = 1;
  let closed = false;

  const output = readline.createInterface({ input: child.stdout });

  const cleanup = () => {
    output.close();
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("App server connection closed before the request completed."));
    }
    pending.clear();
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    child.stdin.end();
    child.kill("SIGTERM");
  };

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  child.on("error", (error) => {
    cleanup();
    throw error;
  });

  child.on("exit", (code, signal) => {
    if (!closed) {
      cleanup();
      closed = true;
      if (code !== 0 || signal) {
        // Best effort: unresolved requests are rejected in cleanup().
      }
    }
  });

  output.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    pending.delete(message.id);

    if (message.error) {
      const errorMessage = message.error.message || JSON.stringify(message.error);
      entry.reject(new Error(errorMessage));
      return;
    }

    entry.resolve(message.result);
  });

  const sendRequest = (method, params) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;

    const timer = createTimeout(
      method,
      timeoutMs,
      (error) => {
        pending.delete(id);
        reject(error);
      },
    );

    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify(buildRequest(id, method, params))}\n`);
  });

  const sendNotification = (method, params) => {
    child.stdin.write(`${JSON.stringify(buildNotification(method, params))}\n`);
  };

  return {
    close,
    sendRequest,
    sendNotification,
    getStderr() {
      return stderrChunks.join("");
    },
  };
}

export async function readOfficialRateLimits({
  codexCommand = "codex",
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess,
} = {}) {
  const session = await createAppServerSession({
    codexCommand,
    env,
    cwd,
    timeoutMs,
    spawnProcess,
  });

  try {
    await session.sendRequest("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    });

    session.sendNotification("initialized");

    const result = await session.sendRequest("account/rateLimits/read");
    return {
      snapshot: normalizeRateLimitSnapshot(result),
      stderr: session.getStderr(),
    };
  } catch (error) {
    const stderr = session.getStderr();
    const suffix = stderr ? ` stderr: ${stderr.trim()}` : "";
    throw new Error(`${error.message}${suffix}`);
  } finally {
    session.close();
  }
}

export async function readCachedRateLimits({ codexHome }) {
  const archivedSessionsDir = path.join(codexHome, "archived_sessions");

  let files;
  try {
    files = await fs.readdir(archivedSessionsDir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`No archived sessions found in ${archivedSessionsDir}.`);
    }
    throw error;
  }

  const candidates = files
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .sort()
    .reverse();

  for (const fileName of candidates) {
    const filePath = path.join(archivedSessionsDir, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean).reverse();

    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        parsed?.type === "event_msg" &&
        parsed?.payload?.type === TOKEN_COUNT_EVENT_TYPE &&
        parsed?.payload?.rate_limits
      ) {
        return {
          snapshot: normalizeRateLimitSnapshot(parsed.payload.rate_limits),
          filePath,
          timestamp: parsed.timestamp ?? null,
        };
      }
    }
  }

  throw new Error(`No cached official rate limit snapshot found in ${archivedSessionsDir}.`);
}
