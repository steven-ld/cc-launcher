import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { loadPoolConfig } from "../src/pool-config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.js");

function createCcSwitchDb(dbPath, options = {}) {
  const {
    commonConfigCodex = 'model_reasoning_effort = "high"\n',
  } = options;
  const database = new DatabaseSync(dbPath);

  database.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      website_url TEXT,
      category TEXT,
      created_at INTEGER,
      sort_index INTEGER,
      notes TEXT,
      icon TEXT,
      icon_color TEXT,
      meta TEXT NOT NULL DEFAULT '{}',
      is_current BOOLEAN NOT NULL DEFAULT 0,
      in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
      cost_multiplier TEXT NOT NULL DEFAULT '1.0',
      limit_daily_usd TEXT,
      limit_monthly_usd TEXT,
      provider_type TEXT,
      PRIMARY KEY (id, app_type)
    );

    CREATE TABLE provider_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      url TEXT NOT NULL,
      added_at INTEGER
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertProvider = database.prepare(`
    INSERT INTO providers (id, app_type, name, settings_config, meta, is_current, sort_index)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSetting = database.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
  `);

  insertSetting.run("common_config_codex", commonConfigCodex);

  insertProvider.run(
    "provider-a",
    "codex",
    "OpenAI Official",
    JSON.stringify({
      auth: {
        OPENAI_API_KEY: null,
        auth_mode: "chatgpt",
        last_refresh: "2026-03-26T08:09:09.502061Z",
        tokens: {
          access_token: "access-a",
          account_id: "11111111-1111-1111-1111-111111111111",
          id_token: "id-a",
          refresh_token: "refresh-a",
        },
      },
      config: 'model = "gpt-5.4"\n',
    }),
    JSON.stringify({ commonConfigEnabled: true }),
    0,
    1,
  );

  insertProvider.run(
    "provider-b",
    "codex",
    "OpenAI Official",
    JSON.stringify({
      auth: {
        OPENAI_API_KEY: null,
        auth_mode: "chatgpt",
        last_refresh: "2026-03-26T08:10:00.000000Z",
        tokens: {
          access_token: "access-b",
          account_id: "22222222-2222-2222-2222-222222222222",
          id_token: "id-b",
          refresh_token: "refresh-b",
        },
      },
      config: "",
    }),
    JSON.stringify({}),
    0,
    2,
  );

  insertProvider.run(
    "provider-placeholder",
    "codex",
    "OpenAI Official",
    JSON.stringify({
      auth: {},
      config: "",
    }),
    JSON.stringify({ commonConfigEnabled: true }),
    1,
    3,
  );

  insertProvider.run(
    "provider-claude",
    "claude",
    "MiniMax",
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "secret",
      },
    }),
    JSON.stringify({ apiFormat: "anthropic" }),
    0,
    4,
  );

  database.close();
}

async function withTempHome(run) {
  const previousHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-home-"));

  process.env.HOME = tempHome;
  try {
    await run(tempHome);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function withTempCwd(nextCwd, run) {
  const previousCwd = process.cwd();
  process.chdir(nextCwd);
  try {
    await run();
  } finally {
    process.chdir(previousCwd);
  }
}

test("loadPoolConfig imports codex profiles from a cc-switch database source", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-switch-"));
  const configDir = path.join(tempRoot, "config");
  const dbPath = path.join(tempRoot, "cc-switch.db");
  await fs.mkdir(configDir, { recursive: true });
  createCcSwitchDb(dbPath);

  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        runtimeRoot: "../.codex-pool",
        profileSource: {
          type: "cc-switch",
          dbPath: "../cc-switch.db",
          appType: "codex",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const { config } = await loadPoolConfig(path.join(configDir, "pool.local.json"));
  const accountIds = config.profiles
    .map((profile) => profile.auth?.tokens?.account_id)
    .filter(Boolean)
    .sort();

  assert.deepEqual(accountIds, [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
  ]);
  assert.equal(config.profiles.length, 2);

  const mergedProfile = config.profiles.find(
    (profile) => profile.auth?.tokens?.account_id === "11111111-1111-1111-1111-111111111111",
  );
  assert.ok(mergedProfile);
  assert.match(mergedProfile.configToml, /model = "gpt-5\.4"/);
  assert.match(mergedProfile.configToml, /model_reasoning_effort = "high"/);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("loadPoolConfig keeps provider root keys before common config tables", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-switch-"));
  const configDir = path.join(tempRoot, "config");
  const dbPath = path.join(tempRoot, "cc-switch.db");
  await fs.mkdir(configDir, { recursive: true });
  createCcSwitchDb(dbPath, {
    commonConfigCodex: `
model_reasoning_effort = "xhigh"

[notice.model_migrations]
"gpt-5.3-codex" = "gpt-5.4"

[features]
multi_agent = true
`,
  });

  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        runtimeRoot: "../.codex-pool",
        profileSource: {
          type: "cc-switch",
          dbPath: "../cc-switch.db",
          appType: "codex",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const { config } = await loadPoolConfig(path.join(configDir, "pool.local.json"));
  const mergedProfile = config.profiles.find(
    (profile) => profile.auth?.tokens?.account_id === "11111111-1111-1111-1111-111111111111",
  );

  assert.ok(mergedProfile);
  assert.match(
    mergedProfile.configToml,
    /model_reasoning_effort = "xhigh"\n\nmodel = "gpt-5\.4"\n\n\[notice\.model_migrations\]/,
  );

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("loadPoolConfig auto-discovers ~/.cc-switch/cc-switch.db when no config is present", async () => {
  await withTempHome(async (tempHome) => {
    const dbDir = path.join(tempHome, ".cc-switch");
    const dbPath = path.join(dbDir, "cc-switch.db");
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cwd-"));
    await fs.mkdir(dbDir, { recursive: true });
    createCcSwitchDb(dbPath);

    await withTempCwd(workspaceDir, async () => {
      const loaded = await loadPoolConfig(undefined, {
        appType: "codex",
      });

      assert.equal(loaded.configPath, null);
      assert.equal(loaded.metadata?.source?.dbPath, dbPath);
      assert.equal(loaded.config.profiles.length, 2);
    });

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});

test("loadPoolConfig ignores workspace pool.local.json unless config is explicit", async () => {
  await withTempHome(async (tempHome) => {
    const dbDir = path.join(tempHome, ".cc-switch");
    const dbPath = path.join(dbDir, "cc-switch.db");
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cwd-"));
    const workspaceConfigDir = path.join(workspaceDir, "config");
    await fs.mkdir(dbDir, { recursive: true });
    await fs.mkdir(workspaceConfigDir, { recursive: true });
    createCcSwitchDb(dbPath);
    await fs.writeFile(
      path.join(workspaceConfigDir, "pool.local.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: [
            {
              name: "broken-local-profile",
              authFile: "./auth.test.json",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    await withTempCwd(workspaceDir, async () => {
      const loaded = await loadPoolConfig(undefined, {
        appType: "codex",
      });

      assert.equal(loaded.configPath, null);
      assert.equal(loaded.metadata?.source?.dbPath, dbPath);
      assert.equal(loaded.config.profiles.length, 2);
      assert.ok(loaded.config.profiles.every((profile) => profile.name !== "broken-local-profile"));
    });

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});

test("loadPoolConfig can import env-only claude profiles from cc-switch", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-switch-"));
  const dbPath = path.join(tempRoot, "cc-switch.db");
  createCcSwitchDb(dbPath);

  await withTempCwd(tempRoot, async () => {
    const loaded = await loadPoolConfig(undefined, {
      sourceType: "cc-switch",
      sourceDbPath: dbPath,
      appType: "claude",
    });

    assert.equal(loaded.config.profiles.length, 1);
    assert.equal(loaded.config.profiles[0].sourceMeta.appType, "claude");
    assert.equal(loaded.config.profiles[0].env.ANTHROPIC_AUTH_TOKEN, "secret");
  });

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("CLI list and dry-run work against cc-switch as a live profile source", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-switch-"));
  const dbPath = path.join(tempRoot, "cc-switch.db");
  createCcSwitchDb(dbPath);

  const imported = await loadPoolConfig(undefined, {
    sourceType: "cc-switch",
    sourceDbPath: dbPath,
  });
  const selectedProfile = imported.config.profiles[0];

  const listResult = spawnSync(
    process.execPath,
    [CLI_ENTRY, "list", "--pool-source", "cc-switch", "--pool-source-db", dbPath],
    {
      cwd: tempRoot,
      encoding: "utf8",
    },
  );

  assert.equal(listResult.status, 0);
  const listedProfiles = listResult.stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(listedProfiles.length, 2);
  assert.ok(listedProfiles.every((line) => line.includes("auth=inline")));

  const runResult = spawnSync(
    process.execPath,
    [
      CLI_ENTRY,
      "run",
      "--pool-source",
      "cc-switch",
      "--pool-source-db",
      dbPath,
      "--pool-profile",
      selectedProfile.name,
      "--pool-dry-run",
      "--",
      "--help",
    ],
    {
      cwd: tempRoot,
      encoding: "utf8",
    },
  );

  assert.equal(runResult.status, 0);
  assert.match(runResult.stdout, new RegExp(`profile: ${selectedProfile.name}`));
  assert.match(runResult.stdout, /CODEX_HOME: .+/);
  assert.match(runResult.stderr, /launching: codex --help/);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("CLI source flags can populate a config file that only carries shared settings", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-switch-"));
  const configDir = path.join(tempRoot, "config");
  const dbPath = path.join(tempRoot, "cc-switch.db");
  await fs.mkdir(configDir, { recursive: true });
  createCcSwitchDb(dbPath);

  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        runtimeRoot: "../.codex-pool",
        sharedEnv: {
          OPENAI_API_KEY: null,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      CLI_ENTRY,
      "list",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-source",
      "cc-switch",
      "--pool-source-db",
      dbPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  const listedProfiles = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(listedProfiles.length, 2);
  assert.ok(listedProfiles.every((line) => line.includes("auth=inline")));

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("write-mode runs prune stale managed runtime homes after cc-switch providers are removed", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cc-switch-"));
  const configDir = path.join(tempRoot, "config");
  const dbPath = path.join(tempRoot, "cc-switch.db");
  const fakeCodexPath = path.join(tempRoot, "fake-codex");
  await fs.mkdir(configDir, { recursive: true });
  createCcSwitchDb(dbPath);
  await fs.writeFile(
    path.join(configDir, "pool.local.json"),
    JSON.stringify(
      {
        version: 1,
        runtimeRoot: "../.codex-pool",
        profileSource: {
          type: "cc-switch",
          dbPath: "../cc-switch.db",
          appType: "codex",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(fakeCodexPath, "#!/usr/bin/env node\nprocess.exit(0)\n", "utf8");
  await fs.chmod(fakeCodexPath, 0o755);

  const initialImport = await loadPoolConfig(path.join(configDir, "pool.local.json"));
  const firstProfile = initialImport.config.profiles.find(
    (profile) => profile.auth?.tokens?.account_id === "11111111-1111-1111-1111-111111111111",
  );
  const secondProfile = initialImport.config.profiles.find(
    (profile) => profile.auth?.tokens?.account_id === "22222222-2222-2222-2222-222222222222",
  );

  assert.ok(firstProfile);
  assert.ok(secondProfile);

  const firstRun = spawnSync(
    process.execPath,
    [
      CLI_ENTRY,
      "run",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-profile",
      firstProfile.name,
      "--pool-bin",
      fakeCodexPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(firstRun.status, 0);

  const runtimeRoot = path.join(tempRoot, ".codex-pool");
  const firstRuntimeHome = path.join(runtimeRoot, firstProfile.name);
  const secondRuntimeHome = path.join(runtimeRoot, secondProfile.name);
  const managedStatePath = path.join(runtimeRoot, ".cc-launcher-managed.json");

  await fs.access(firstRuntimeHome);
  const seededState = JSON.parse(await fs.readFile(managedStatePath, "utf8"));
  assert.deepEqual(
    seededState.profiles.map((profile) => profile.key).sort(),
    ["provider-a", "provider-b"],
  );

  const database = new DatabaseSync(dbPath);
  database.prepare(`DELETE FROM providers WHERE id = ? AND app_type = ?`).run("provider-a", "codex");
  database.close();

  const secondRun = spawnSync(
    process.execPath,
    [
      CLI_ENTRY,
      "run",
      "--pool-config",
      path.join(configDir, "pool.local.json"),
      "--pool-profile",
      secondProfile.name,
      "--pool-bin",
      fakeCodexPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(secondRun.status, 0);
  await assert.rejects(fs.access(firstRuntimeHome));
  await fs.access(secondRuntimeHome);

  const prunedState = JSON.parse(await fs.readFile(managedStatePath, "utf8"));
  assert.deepEqual(prunedState.profiles.map((profile) => profile.key), ["provider-b"]);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("doctor reports install guidance when neither config nor default cc-switch db exists", async () => {
  await withTempHome(async (tempHome) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cli-"));
    const result = spawnSync(process.execPath, [CLI_ENTRY, "doctor"], {
      cwd: tempRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempHome,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /No pool config or cc-switch database found/);
    assert.match(output, /Install cc-switch and sign in first/);
    assert.doesNotMatch(output, /^No pool config found\./m);

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});

test("init succeeds from the default cc-switch db without a project config file", async () => {
  await withTempHome(async (tempHome) => {
    const dbDir = path.join(tempHome, ".cc-switch");
    const dbPath = path.join(dbDir, "cc-switch.db");
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-cli-"));
    await fs.mkdir(dbDir, { recursive: true });
    createCcSwitchDb(dbPath);

    const result = spawnSync(process.execPath, [CLI_ENTRY, "init"], {
      cwd: tempRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempHome,
      },
    });

    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /initialized: ccodex/);
    assert.match(result.stdout, new RegExp(`source_db: ${dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
