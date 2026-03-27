import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import readline from "node:readline";

import { pickProfile, resolveProxyConfig } from "./pool-config.js";
import { selectLaunchProfile, startRateLimitCacheRefresh, stopRateLimitCacheRefresh } from "./profile-selection.js";
import { prepareCodexHome } from "./runtime-home.js";
import { getProfileStateManager } from "./profile-state.js";

// Auth error patterns that indicate expired/invalid credentials
const AUTH_ERROR_PATTERNS = [
  /auth.*fail/i,
  /token.*expired/i,
  /invalid.*auth/i,
  /401\s+Unauthorized/i,
  /unauthorized.*api/i,
  /not.*authenticated/i,
  /please.*log.*in/i,
  /authentication.*required/i,
  /credentials.*expired/i,
  /oauth.*fail/i,
  /invalid.*token/i,
  /login.*required/i,
  /session.*expired/i,
  /refresh.*token.*fail/i,
];

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function buildProxyAddress({ protocol, host, port }) {
  return `${protocol}://${host}:${port}`;
}

function shouldSendRequestBody(method) {
  return !["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
}

function copyRequestHeaders(headers, profile) {
  const copied = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedKey) || normalizedKey.startsWith("x-cc-launcher-")) {
      continue;
    }

    if (Array.isArray(value)) {
      copied.set(key, value.join(", "));
      continue;
    }

    if (value !== undefined) {
      copied.set(key, String(value));
    }
  }

  const authToken = profile.env?.ANTHROPIC_AUTH_TOKEN ?? profile.env?.ANTHROPIC_API_KEY;
  if (authToken) {
    copied.set("authorization", `Bearer ${authToken}`);
    copied.set("x-api-key", authToken);
  }

  return copied;
}

function copyResponseHeaders(headers, response) {
  headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      return;
    }
    response.setHeader(key, value);
  });
}

function respondJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function resolveClaudeTarget(profile) {
  // Prefer the upstream URL stored in sourceMeta (survives Base URL stripping
  // in mergeManagedEnv). Fall back to profile.env for other profile sources.
  const storedUrl = profile.sourceMeta?.upstreamUrl;
  const baseUrl = storedUrl ?? profile.env?.ANTHROPIC_BASE_URL;
  if (!baseUrl || typeof baseUrl !== "string") {
    throw new Error(`Profile ${profile.name} does not define ANTHROPIC_BASE_URL.`);
  }

  return new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function resolveRequestedProfile(config, request) {
  const profileNameHeader = request.headers["x-cc-launcher-profile"];
  const profileName = Array.isArray(profileNameHeader) ? profileNameHeader[0] : profileNameHeader;

  if (profileName) {
    return pickProfile(config, { profileName });
  }

  return pickProfile(config);
}

function installSignalHandlers(onSignal) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.on(signal, onSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, onSignal);
    }
  };
}

function createServerLifecycle(server) {
  return new Promise((resolve, reject) => {
    const shutdown = () => {
      cleanup();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(0);
      });
    };

    const cleanup = installSignalHandlers(shutdown);
    server.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function startClaudeProxy({ config, cliContext, host, port }) {
  const address = buildProxyAddress({ protocol: "http", host, port });

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = request.url || "/";
      if (requestUrl === "/__cc-launcher/health") {
        return respondJson(response, 200, {
          ok: true,
          appType: cliContext.appType,
          profiles: config.profiles.map((profile) => profile.name),
        });
      }

      if (requestUrl === "/__cc-launcher/providers") {
        return respondJson(response, 200, {
          appType: cliContext.appType,
          profiles: config.profiles.map((profile) => ({
            name: profile.name,
            providerId: profile.sourceMeta?.providerId ?? null,
            upstream: profile.sourceMeta?.upstreamUrl ?? profile.env?.ANTHROPIC_BASE_URL ?? null,
          })),
        });
      }

      const profile = resolveRequestedProfile(config, request);
      const upstreamBaseUrl = resolveClaudeTarget(profile);
      const upstreamUrl = new URL(requestUrl, upstreamBaseUrl);
      const requestHeaders = copyRequestHeaders(request.headers, profile);
      const abortController = new AbortController();
      request.on("aborted", () => abortController.abort());
      response.on("close", () => abortController.abort());

      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: requestHeaders,
        body: shouldSendRequestBody(request.method) ? request : undefined,
        duplex: shouldSendRequestBody(request.method) ? "half" : undefined,
        signal: abortController.signal,
      });

      response.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse.headers, response);
      response.setHeader("x-cc-launcher-profile", profile.name);
      response.setHeader("x-cc-launcher-provider-id", profile.sourceMeta?.providerId ?? profile.name);

      if (!upstreamResponse.body) {
        response.end();
        return;
      }

      Readable.fromWeb(upstreamResponse.body).pipe(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respondJson(response, 502, {
        error: {
          message,
        },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  process.stdout.write(`proxy: ${address}\n`);
  process.stderr.write(`[cc-launcher] ${cliContext.cliName} proxy listening on ${address}\n`);

  return createServerLifecycle(server);
}

function createWebSocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;

  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

function sendWebSocketText(socket, text) {
  socket.write(encodeWebSocketFrame(0x1, Buffer.from(String(text))));
}

function sendWebSocketClose(socket, code = 1000, reason = "") {
  const reasonBuffer = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  socket.write(encodeWebSocketFrame(0x8, payload));
}

function sendWebSocketPong(socket, payload = Buffer.alloc(0)) {
  socket.write(encodeWebSocketFrame(0xA, payload));
}

function installWebSocketParser(socket, handlers) {
  let buffer = Buffer.alloc(0);
  let fragmentedText = "";

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < offset + 2) {
          return;
        }
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) {
          return;
        }
        payloadLength = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + payloadLength) {
        return;
      }

      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
      buffer = buffer.subarray(offset + payloadLength);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        handlers.onClose?.(payload);
        return;
      }

      if (opcode === 0x9) {
        handlers.onPing?.(payload);
        continue;
      }

      if (opcode === 0xA) {
        continue;
      }

      if (opcode !== 0x1 && opcode !== 0x0) {
        handlers.onUnsupported?.(opcode);
        continue;
      }

      fragmentedText += payload.toString("utf8");
      if (!fin) {
        continue;
      }

      handlers.onText?.(fragmentedText);
      fragmentedText = "";
    }
  });
}

function createCodexMetadataPayload(config) {
  return {
    appType: "codex",
    profiles: config.profiles.map((profile) => ({
      name: profile.name,
      providerId: profile.sourceMeta?.providerId ?? null,
      accountId: profile.sourceMeta?.accountId ?? null,
    })),
  };
}

async function selectCodexProfile({ configDir, config, cliContext, profileName, launchCommand }) {
  return selectLaunchProfile({
    configDir,
    config,
    cliContext,
    profileName,
    launchCommand,
    allowLiveProbe: true,
  });
}

async function startCodexProxy({
  config,
  configDir,
  cliContext,
  launchCommand,
  profileName,
  host,
  port,
}) {
  const address = buildProxyAddress({ protocol: "ws", host, port });
  const server = http.createServer((request, response) => {
    if (request.url === "/__cc-launcher/health") {
      return respondJson(response, 200, {
        ok: true,
        proxy: address,
        fixedProfile: profileName ?? null,
        ...createCodexMetadataPayload(config),
      });
    }

    if (request.url === "/__cc-launcher/providers") {
      return respondJson(response, 200, createCodexMetadataPayload(config));
    }

    respondJson(response, 404, {
      error: {
        message: "Not found.",
      },
    });
  });

  server.on("upgrade", async (request, socket) => {
    socket.on("error", () => {});

    const key = request.headers["sec-websocket-key"];
    const upgrade = String(request.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
      const requestedProfileName = profileName ?? url.searchParams.get("profile") ?? undefined;
      const selection = await selectCodexProfile({
        configDir,
        config,
        cliContext,
        profileName: requestedProfileName,
        launchCommand,
      });
      const selectedProfile = selection.profile;
      const runtime = await prepareCodexHome({
        configDir,
        config,
        profile: selectedProfile,
        appType: cliContext.appType,
        writeFiles: true,
      });
      const child = spawn(launchCommand, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: runtime.env,
      });
      const acceptKey = createWebSocketAccept(String(key));
      const output = readline.createInterface({ input: child.stdout });
      let closed = false;

      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        `X-CC-Launcher-Profile: ${selectedProfile.name}`,
        `X-CC-Launcher-Provider-Id: ${selectedProfile.sourceMeta?.providerId ?? selectedProfile.name}`,
        "",
        "",
      ].join("\r\n"));

      const closeResources = (closeSocket = true) => {
        if (closed) {
          return;
        }
        closed = true;
        output.close();
        child.stdin.end();
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        if (closeSocket && !socket.destroyed) {
          socket.end();
        }
      };

      output.on("line", (line) => {
        if (!socket.destroyed) {
          sendWebSocketText(socket, line);
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        process.stderr.write(`[cc-launcher] codex app-server(${selectedProfile.name}): ${text}`);
        
        // Check if this is an auth-related error
        for (const pattern of AUTH_ERROR_PATTERNS) {
          if (pattern.test(text)) {
            const stateManager = getProfileStateManager();
            stateManager.disable(selectedProfile.name, `auth_error: ${text.slice(0, 100)}`);
            process.stderr.write(`[cc-launcher] Disabled ${selectedProfile.name} due to auth error. Will retry in 30 minutes.\n`);
            break;
          }
        }
      });

      child.on("exit", (code, signal) => {
        if (closed) {
          return;
        }

        if (!socket.destroyed) {
          sendWebSocketClose(socket, 1011, `app-server exited (${code ?? signal ?? "unknown"})`);
        }
        closeResources();
      });

      child.on("error", (error) => {
        if (closed) {
          return;
        }
        if (!socket.destroyed) {
          sendWebSocketClose(socket, 1011, error.message);
        }
        closeResources();
      });

      installWebSocketParser(socket, {
        onText(text) {
          child.stdin.write(`${text}\n`);
        },
        onPing(payload) {
          sendWebSocketPong(socket, payload);
        },
        onClose(payload) {
          if (!socket.destroyed) {
            socket.write(encodeWebSocketFrame(0x8, payload));
          }
          closeResources();
        },
        onUnsupported() {
          sendWebSocketClose(socket, 1003, "binary frames are not supported");
          closeResources();
        },
      });

      socket.on("close", () => closeResources(false));
      socket.on("end", () => closeResources(false));
      socket.on("error", () => closeResources(false));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.write(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n${JSON.stringify({ error: { message } })}`,
      );
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  process.stdout.write(`proxy: ${address}\n`);
  if (profileName) {
    process.stdout.write(`profile: ${profileName}\n`);
  }
  process.stderr.write(`[cc-launcher] ${cliContext.cliName} proxy listening on ${address}\n`);

  return createServerLifecycle(server);
}

export async function runProxyCommand({
  parsed,
  config,
  configDir,
  cliContext,
}) {
  const launchCommand = parsed.codexCommand || config.codexCommand || cliContext.command;
  const proxy = {
    ...resolveProxyConfig(config, cliContext.appType),
    ...(parsed.proxyHost ? { host: parsed.proxyHost } : {}),
    ...(parsed.proxyPort ? { port: parsed.proxyPort } : {}),
  };

  // Start background rate limit cache refresh
  // Note: CC Cloud probe is NOT started here to avoid probing non-standard providers
  // on every proxy startup. Cache is refreshed only via explicit `ccodex cache` / `cclaude cache` commands.
  let cacheRefreshStopped = false;
  const cacheRefreshOptions = {
    codexCommand: launchCommand,
    appType: cliContext.appType,
  };
  // Only start background refresh for Codex (quota-based probing is safe and fast).
  // For Claude/CC Cloud: probe only when explicitly requested.
  let proxyCacheRefresh = null;
  if (cliContext.appType === "codex") {
    proxyCacheRefresh = startRateLimitCacheRefresh(config.profiles, cacheRefreshOptions);
    process.stderr.write(`[cc-launcher] rate limit cache started (refreshes every 5 minutes)\n`);
  }

  // Helper to stop cache refresh on shutdown (safe when not running)
  const stopCacheRefresh = () => {
    if (!cacheRefreshStopped && proxyCacheRefresh) {
      cacheRefreshStopped = true;
      stopRateLimitCacheRefresh();
    }
  };

  // Helper to restart cache refresh (used by SIGHUP reload — Codex only)
  const restartCacheRefresh = async () => {
    if (cliContext.appType !== "codex") return;
    stopCacheRefresh();
    const stateManager = getProfileStateManager();
    await stateManager.load();
    const enabledProfiles = stateManager.filterEnabled(config.profiles);
    if (enabledProfiles.length > 0) {
      proxyCacheRefresh = startRateLimitCacheRefresh(enabledProfiles, cacheRefreshOptions);
      process.stderr.write(`[cc-launcher] rate limit cache restarted (${enabledProfiles.length} profiles)\n`);
    }
  };

  // Install signal handlers for cleanup
  const cleanupSignals = ["SIGINT", "SIGTERM"];
  const signalHandlers = {};
  for (const sig of cleanupSignals) {
    signalHandlers[sig] = () => stopCacheRefresh();
    process.on(sig, signalHandlers[sig]);
  }

  // SIGHUP: reload profile state and restart cache refresh (config file changes)
  const sighupHandler = async () => {
    process.stderr.write("[cc-launcher] SIGHUP — reloading profile state and restarting cache...\n");
    await restartCacheRefresh();
  };
  process.on("SIGHUP", sighupHandler);
  signalHandlers["SIGHUP"] = () => {
    stopCacheRefresh();
    process.removeListener("SIGHUP", sighupHandler);
  };

  let result;
  try {
    if (cliContext.appType === "claude") {
      result = await startClaudeProxy({
        config,
        cliContext,
        host: proxy.host,
        port: proxy.port,
      });
    } else {
      result = await startCodexProxy({
        config,
        configDir,
        cliContext,
        launchCommand,
        profileName: parsed.profileName,
        host: proxy.host,
        port: proxy.port,
      });
    }
  } finally {
    stopCacheRefresh();
    for (const sig of cleanupSignals) {
      process.removeListener(sig, signalHandlers[sig]);
    }
    if (signalHandlers["SIGHUP"]) {
      process.removeListener("SIGHUP", signalHandlers["SIGHUP"]);
    }
  }

  return result;
}
