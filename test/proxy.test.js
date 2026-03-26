import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function waitForOutput(stream, pattern, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for output: ${pattern}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += String(chunk);
      if (pattern.test(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
    };

    stream.on("data", onData);
  });
}

function waitForChildExit(child) {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for file ${filePath}`);
}

function waitForWebSocketMessage(socket, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message."));
    }, timeoutMs);

    const onMessage = (event) => {
      cleanup();
      resolve(event.data);
    };

    const onError = (event) => {
      cleanup();
      reject(event.error ?? new Error("WebSocket error."));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };

    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

test("cclaude proxy forwards requests to provider upstreams", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cc-launcher-proxy-"));
  const configDir = path.join(tempRoot, "config");
  const upstreamPort = await getFreePort();
  const proxyPort = await getFreePort();
  await fs.mkdir(configDir, { recursive: true });

  const seenRequests = [];
  const upstreamServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    seenRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"],
      body: Buffer.concat(chunks).toString("utf8"),
    });

    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstreamServer.listen(upstreamPort, "127.0.0.1", resolve));

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await new Promise((resolve, reject) => upstreamServer.close((error) => (error ? reject(error) : resolve())));
  });

  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        proxy: {
          host: "127.0.0.1",
          port: proxyPort,
        },
        profiles: [
          {
            name: "glm",
            env: {
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
              ANTHROPIC_AUTH_TOKEN: "provider-secret",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const child = spawn(process.execPath, ["bin/cclaude.js", "proxy", "--pool-config", path.join(configDir, "pool.local.json")], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    await waitForChildExit(child);
  });

  await waitForOutput(child.stdout, new RegExp(`proxy: http://127\\.0\\.0\\.1:${proxyPort}`));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cc-launcher-profile": "glm",
    },
    body: JSON.stringify({ model: "claude-sonnet", max_tokens: 64, messages: [{ role: "user", content: "ping" }] }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-cc-launcher-profile"), "glm");
  assert.deepEqual(payload, { ok: true });
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].url, "/v1/messages");
  assert.equal(seenRequests[0].authorization, "Bearer provider-secret");
  assert.equal(seenRequests[0].apiKey, "provider-secret");
  assert.match(seenRequests[0].body, /"ping"/);
});

test("ccodex proxy bridges websocket clients to profile-scoped app-server subprocesses", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cc-launcher-proxy-"));
  const configDir = path.join(tempRoot, "config");
  const fakeCodexPath = path.join(tempRoot, "fake-codex");
  const logPath = path.join(tempRoot, "bridge.json");
  const proxyPort = await getFreePort();
  await fs.mkdir(configDir, { recursive: true });

  await fs.writeFile(
    path.join(configDir, "team-a.auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "account-a",
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        runtimeRoot: "../.codex-pool",
        profiles: [
          {
            name: "team-a",
            authFile: "./team-a.auth.json",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args: process.argv.slice(2),
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
  },
}, null, 2));

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: process.env.CODEX_HOME } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ id: message.id, result: { echoed: true } }) + "\\n");
  }
}
`,
    "utf8",
  );
  await fs.chmod(fakeCodexPath, 0o755);

  const child = spawn(
    process.execPath,
    [
      "src/cli.js",
      "proxy",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-bin",
      fakeCodexPath,
      "--pool-proxy-port",
      String(proxyPort),
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  t.after(async () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    await waitForChildExit(child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await waitForOutput(child.stdout, new RegExp(`proxy: ws://127\\.0\\.0\\.1:${proxyPort}`));

  const socket = new WebSocket(`ws://127.0.0.1:${proxyPort}/?profile=team-a`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test" } } }));
  const message = JSON.parse(await waitForWebSocketMessage(socket));

  assert.equal(message.id, 1);
  assert.match(message.result.userAgent, /\.codex-pool\/team-a$/);

  socket.close();
  await new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));

  const bridgePayload = JSON.parse(await waitForFile(logPath));
  assert.deepEqual(bridgePayload.args, ["app-server", "--listen", "stdio://"]);
  assert.match(bridgePayload.env.CODEX_HOME, /\.codex-pool\/team-a$/);
});
