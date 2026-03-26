import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.js");

function createCcSwitchDb(dbPath) {
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

  insertSetting.run("common_config_codex", 'model_reasoning_effort = "high"\n');

  insertProvider.run(
    "provider-a",
    "codex",
    "OpenAI Official",
    JSON.stringify({
      auth: {
        OPENAI_API_KEY: null,
        auth_mode: "chatgpt",
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

  database.close();
}

async function createHomeFixture({ withDb }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-product-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const ccSwitchDir = path.join(homeDir, ".cc-switch");
  const dbPath = path.join(ccSwitchDir, "cc-switch.db");

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });

  if (withDb) {
    await fs.mkdir(ccSwitchDir, { recursive: true });
    createCcSwitchDb(dbPath);
  }

  return {
    tempRoot,
    homeDir,
    workspaceDir,
    dbPath,
  };
}

function makeChildEnv(homeDir, extraEnv = {}) {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...extraEnv,
  };
}

function runNodeEntry(entryPath, args, options) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
}

async function readPackageJson() {
  const packagePath = path.join(REPO_ROOT, "package.json");
  return JSON.parse(await fs.readFile(packagePath, "utf8"));
}

async function getPackageBinPath(name) {
  const pkg = await readPackageJson();
  const binPath = pkg.bin?.[name];
  assert.equal(typeof binPath, "string", `package.json must expose npm bin "${name}"`);
  return path.resolve(REPO_ROOT, binPath);
}

function assertInstallGuidance(output) {
  assert.doesNotMatch(output, /No pool config found/i);
  assert.match(output, /\.cc-switch\/cc-switch\.db/);
  assert.match(output, /install/i);
  assert.match(output, /cc-switch/i);
}

test("package.json exposes ccodex and cclaude npm bin entries", async () => {
  const pkg = await readPackageJson();

  assert.equal(typeof pkg.bin?.ccodex, "string");
  assert.equal(typeof pkg.bin?.cclaude, "string");
});

test("ccodex npm bin doctor succeeds when the default cc-switch db exists", async () => {
  const fixture = await createHomeFixture({ withDb: true });
  const entryPath = await getPackageBinPath("ccodex");

  try {
    const result = runNodeEntry(entryPath, ["doctor"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0);
    assert.match(output, /cli: ccodex/i);
    assert.match(output, /status: ready/i);
    assert.match(output, /\.cc-switch\/cc-switch\.db/);
    assert.doesNotMatch(output, /No pool config found/i);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("cclaude npm bin help advertises init and doctor commands", async () => {
  const fixture = await createHomeFixture({ withDb: false });
  const entryPath = await getPackageBinPath("cclaude");

  try {
    const result = runNodeEntry(entryPath, ["--help"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0);
    assert.match(output, /\binit\b/i);
    assert.match(output, /\bdoctor\b/i);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("CLI list auto-discovers the default cc-switch db when no config is provided", async () => {
  const fixture = await createHomeFixture({ withDb: true });

  try {
    const result = runNodeEntry(CLI_ENTRY, ["list"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });

    assert.equal(result.status, 0);
    const listedProfiles = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean);

    assert.equal(listedProfiles.length, 2);
    assert.ok(listedProfiles.every((line) => line.includes("auth=inline")));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /No pool config found/i);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("CLI ignores workspace pool.local.json and still uses the default cc-switch db", async () => {
  const fixture = await createHomeFixture({ withDb: true });
  const workspaceConfigDir = path.join(fixture.workspaceDir, "config");
  await fs.mkdir(workspaceConfigDir, { recursive: true });
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

  try {
    const result = runNodeEntry(CLI_ENTRY, ["list"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /auth\.test\.json/i);
    assert.match(result.stdout, /codex-11111111-provider/);
    assert.match(result.stdout, /codex-22222222-provider/);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("CLI auto-discovers ~/.cc-launcher/config.json when present", async () => {
  const fixture = await createHomeFixture({ withDb: true });
  const productConfigDir = path.join(fixture.homeDir, ".cc-launcher");
  await fs.mkdir(productConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(productConfigDir, "config.json"),
    JSON.stringify(
      {
        version: 1,
        selection: {
          strategy: "random",
        },
        profileSource: {
          type: "cc-switch",
          appType: "codex",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  try {
    const result = runNodeEntry(CLI_ENTRY, ["doctor"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0);
    assert.match(output, /\.cc-launcher\/config\.json/);
    assert.match(output, /status: ready/i);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("init succeeds against the default cc-switch db without an explicit config file", async () => {
  const fixture = await createHomeFixture({ withDb: true });

  try {
    const result = runNodeEntry(CLI_ENTRY, ["init"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0);
    assert.match(output, /initialized: ccodex/i);
    assert.match(output, /\.cc-switch\/cc-switch\.db/);
    assert.doesNotMatch(output, /No pool config found/i);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("doctor prints install guidance when the default cc-switch db is missing", async () => {
  const fixture = await createHomeFixture({ withDb: false });

  try {
    const result = runNodeEntry(CLI_ENTRY, ["doctor"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });

    assert.notEqual(result.status, 0);
    assertInstallGuidance(`${result.stdout}${result.stderr}`);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("list prints install guidance when neither config nor the default cc-switch db is available", async () => {
  const fixture = await createHomeFixture({ withDb: false });

  try {
    const result = runNodeEntry(CLI_ENTRY, ["list"], {
      cwd: fixture.workspaceDir,
      env: makeChildEnv(fixture.homeDir),
    });

    assert.notEqual(result.status, 0);
    assertInstallGuidance(`${result.stdout}${result.stderr}`);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});
