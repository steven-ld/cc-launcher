import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pickProfile } from "../src/pool-config.js";
import { prepareCodexHome } from "../src/runtime-home.js";

test("CLI parses wrapper flags and passthrough args in dry-run mode", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const configDir = path.join(tempRoot, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "team-a.auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), "utf8");
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

  const result = spawnSync(
    process.execPath,
    [
      "src/cli.js",
      "run",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-profile=team-a",
      "--pool-bin",
      "codex-nightly",
      "--pool-dry-run",
      "--",
      "--profile",
      "sandboxed",
      "exec",
      "hello",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /profile: team-a/);
  assert.match(result.stdout, /CODEX_HOME: .*\.codex-pool\/team-a/);
  assert.match(result.stderr, /launching: codex-nightly --profile sandboxed exec hello/);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("CLI supports --pool-list alias", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const configDir = path.join(tempRoot, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: [
          { name: "team-a", weight: 2 },
          { name: "team-b", weight: 1 },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    ["src/cli.js", "--pool-list", "--pool-config", path.join(configDir, "pool.local.json")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /team-a\tweight=2\tauth=none/);
  assert.match(result.stdout, /team-b\tweight=1\tauth=none/);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("cclaude run injects isolated runtime settings instead of inheriting user provider env", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const configDir = path.join(tempRoot, "config");
  const fakeClaudePath = path.join(tempRoot, "fake-claude");
  const cclaudeBinPath = path.join(process.cwd(), "bin", "cclaude.js");
  await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  await fs.writeFile(
    path.join(homeDir, ".claude", "settings.json"),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
          ANTHROPIC_MODEL: "MiniMax-M2.7",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.7",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        model: "opus[1m]",
        permissions: {
          allow: ["Bash(git fetch:*)"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        runtimeRoot: "../.claude-pool",
        profiles: [
          {
            name: "glm",
            env: {
              ANTHROPIC_AUTH_TOKEN: "glm-token",
              ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
              ANTHROPIC_MODEL: "glm-5",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  await fs.writeFile(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const settingsIndex = args.indexOf("--settings");
const settingsPath = settingsIndex >= 0 ? args[settingsIndex + 1] : null;
const settingSourcesIndex = args.indexOf("--setting-sources");
const settingSources = settingSourcesIndex >= 0 ? args[settingSourcesIndex + 1] : null;
const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : null;

process.stdout.write(
  "FAKE:" + JSON.stringify({
    args,
    settingSources,
    settings,
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    },
  }) + "\\n",
);
`,
    "utf8",
  );
  await fs.chmod(fakeClaudePath, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      cclaudeBinPath,
      "run",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-bin",
      fakeClaudePath,
    ],
    {
      cwd: workspaceDir,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stderr, /launching: .*fake-claude --settings .*settings\.json --setting-sources project,local/);

  const fakeLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith("FAKE:"));
  assert.ok(fakeLine, "expected fake claude output");

  const payload = JSON.parse(fakeLine.slice("FAKE:".length));
  assert.equal(payload.settingSources, "project,local");
  assert.equal(payload.settings.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(payload.settings.env.ANTHROPIC_MODEL, "glm-5");
  assert.equal(payload.settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(payload.settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(payload.settings.model, undefined);
  assert.deepEqual(payload.settings.permissions.allow, ["Bash(git fetch:*)"]);
  assert.equal(payload.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(payload.env.ANTHROPIC_MODEL, "glm-5");

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("run selects the official Codex profile with the most remaining 5h quota and skips failed auth probes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const configDir = path.join(tempRoot, "config");
  const fakeCodexPath = path.join(tempRoot, "fake-codex");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "official-a.auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "account-a",
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(configDir, "official-b.auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "account-b",
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
        selection: {
          strategy: "max-remaining-5h",
        },
        profiles: [
          {
            name: "official-a",
            authFile: "./official-a.auth.json",
          },
          {
            name: "official-b",
            authFile: "./official-b.auth.json",
          },
          {
            name: "proxy-fallback",
            env: {
              OPENAI_API_KEY: "proxy-token",
            },
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
import path from "node:path";
import readline from "node:readline";

function readAccountId() {
  const authPath = path.join(process.env.CODEX_HOME, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  return auth.tokens?.account_id ?? null;
}

if (process.argv[2] === "app-server") {
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "fake/0.1" } }) + "\\n");
      continue;
    }

    if (msg.method === "account/rateLimits/read") {
      const accountId = readAccountId();
      if (accountId === "account-a") {
        process.stderr.write("auth failed\\n");
        process.exit(1);
      }

      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          rateLimits: {
            limit_id: "codex",
            limit_name: null,
            primary: { used_percent: 18, window_minutes: 300, resets_at: 1774375500 },
            secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1774528615 },
            credits: null,
            plan_type: "team"
          }
        }
      }) + "\\n");
      process.exit(0);
    }
  }
} else {
  process.stdout.write("selected:" + readAccountId() + "\\n");
  process.exit(0);
}
`,
    "utf8",
  );
  await fs.chmod(fakeCodexPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      "src/cli.js",
      "run",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-bin",
      fakeCodexPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /profile: official-b/);
  assert.match(result.stdout, /selected:account-b/);
  assert.match(result.stderr, /selected official profile by 5h remaining: 82% remaining/);
  assert.match(result.stderr, /skipped 1 official profile\(s\) that failed live auth\/rate-limit probing/);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("pickProfile selects by explicit name and weighted random", () => {
  const config = {
    profiles: [
      { name: "alpha", weight: 1 },
      { name: "beta", weight: 3 },
    ],
  };

  assert.equal(pickProfile(config, { profileName: "beta" }).name, "beta");
  assert.equal(pickProfile(config, { random: () => 0.0 }).name, "alpha");
  assert.equal(pickProfile(config, { random: () => 0.5 }).name, "beta");
  assert.throws(() => pickProfile(config, { profileName: "missing" }), /Unknown profile: missing/);
});

test("prepareCodexHome writes auth, config, env, and syncs shared entries", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const configDir = path.join(tempRoot, "config");
  const sharedCodexHome = path.join(tempRoot, "shared-codex-home");

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(sharedCodexHome, { recursive: true });
  await fs.mkdir(path.join(sharedCodexHome, "skills"), { recursive: true });
  await fs.writeFile(path.join(sharedCodexHome, "AGENTS.md"), "shared agents\n", "utf8");
  await fs.writeFile(path.join(sharedCodexHome, "skills", "guide.md"), "shared skill\n", "utf8");
  await fs.writeFile(path.join(configDir, "team-a.auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), "utf8");

  const result = await prepareCodexHome({
    configDir,
    config: {
      runtimeRoot: "../.codex-pool",
      sharedCodexHome: "../shared-codex-home",
      sharedHomeEntries: ["AGENTS.md", "skills"],
      sharedEnv: {
        OPENAI_API_KEY: null,
        HTTPS_PROXY: "http://127.0.0.1:7890",
      },
      sharedConfigToml: 'model = "gpt-5-codex"',
      profiles: [],
    },
    profile: {
      name: "team-a",
      authFile: "./team-a.auth.json",
      env: {
        HTTP_PROXY: "http://127.0.0.1:7890",
      },
    },
    baseEnv: {
      OPENAI_API_KEY: "should-be-removed",
      PATH: process.env.PATH,
    },
  });

  const authPayload = await fs.readFile(result.authJsonPath, "utf8");
  const configPayload = await fs.readFile(result.configTomlPath, "utf8");
  const syncedAgents = await fs.readFile(path.join(result.runtimeHome, "AGENTS.md"), "utf8");
  const syncedSkill = await fs.readFile(path.join(result.runtimeHome, "skills", "guide.md"), "utf8");

  assert.match(result.runtimeHome, /\.codex-pool\/team-a$/);
  assert.deepEqual(JSON.parse(authPayload), { auth_mode: "chatgpt" });
  assert.equal(configPayload, 'model = "gpt-5-codex"\n');
  assert.equal(syncedAgents, "shared agents\n");
  assert.equal(syncedSkill, "shared skill\n");
  assert.equal(result.env.CODEX_HOME, result.runtimeHome);
  assert.equal(result.env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(result.env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal("OPENAI_API_KEY" in result.env, false);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("prepareCodexHome dry-run does not create files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const configDir = path.join(tempRoot, "config");
  await fs.mkdir(configDir, { recursive: true });

  const result = await prepareCodexHome({
    configDir,
    config: {
      runtimeRoot: "../.codex-pool",
      sharedCodexHome: "../shared-codex-home",
      profiles: [],
    },
    profile: {
      name: "preview-only",
      auth: {
        auth_mode: "chatgpt",
      },
    },
    writeFiles: false,
  });

  await assert.rejects(fs.access(result.authJsonPath));
  await assert.rejects(fs.access(result.configTomlPath));

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("usage command prints official live rate limits as JSON", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const configDir = path.join(tempRoot, "config");
  const fakeCodexPath = path.join(tempRoot, "fake-codex");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "team-a.auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), "utf8");
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
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "fake/0.1" } }) + "\\n");
  } else if (msg.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: {
        rateLimits: {
          limit_id: "codex",
          limit_name: null,
          primary: { used_percent: 21, window_minutes: 300, resets_at: 1774375500 },
          secondary: { used_percent: 84, window_minutes: 10080, resets_at: 1774528615 },
          credits: null,
          plan_type: "team"
        }
      }
    }) + "\\n");
    process.exit(0);
  }
}
`,
    "utf8",
  );
  await fs.chmod(fakeCodexPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      "src/cli.js",
      "usage",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-profile",
      "team-a",
      "--pool-bin",
      fakeCodexPath,
      "--pool-json",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.profile, "team-a");
  assert.equal(payload.source, "official-live");
  assert.equal(payload.snapshot.primary.window_minutes, 300);
  assert.equal(payload.snapshot.secondary.window_minutes, 10080);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("usage command falls back to cached official snapshot when live read fails", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const configDir = path.join(tempRoot, "config");
  const fakeCodexPath = path.join(tempRoot, "fake-codex");
  const runtimeHome = path.join(tempRoot, ".codex-pool", "team-a");
  await fs.mkdir(path.join(runtimeHome, "archived_sessions"), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "team-a.auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), "utf8");
  await fs.writeFile(
    path.join(runtimeHome, "archived_sessions", "rollout-2026-03-26T16-00-00-019d0000.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-03-26T08:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: { used_percent: 48, window_minutes: 300, resets_at: 1774375500 },
          secondary: { used_percent: 91, window_minutes: 10080, resets_at: 1774528615 },
          credits: null,
          plan_type: "team"
        }
      }
    })}\n`,
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
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "fake/0.1" } }) + "\\n");
  } else if (msg.method === "account/rateLimits/read") {
    process.stderr.write("live query failed\\n");
    process.exit(1);
  }
}
`,
    "utf8",
  );
  await fs.chmod(fakeCodexPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      "src/cli.js",
      "usage",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-profile",
      "team-a",
      "--pool-bin",
      fakeCodexPath,
      "--pool-json",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stderr, /using cached official snapshot instead/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.source, "cached-official-snapshot");
  assert.equal(payload.snapshot.primary.used_percent, 48);
  assert.equal(payload.snapshot.secondary.used_percent, 91);
  assert.equal(payload.cached.timestamp, "2026-03-26T08:00:00.000Z");

  await fs.rm(tempRoot, { recursive: true, force: true });
});
