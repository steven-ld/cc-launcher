# CC Launcher

`CC Launcher` is a production-oriented CLI launcher for `Codex` and `Claude`, backed by `cc-switch`.

It provides two stable entrypoints after installation:

- `ccodex`
- `cclaude`

The project is designed around four defaults:

- `cc-switch` is the primary profile source
- zero-config startup should work for most users
- local project test configs must not leak into normal runtime
- installation should come from a packaged release, not from cloning source

## Features

- Auto-discovers `~/.cc-switch/cc-switch.db`
- Auto-imports Codex and Claude providers from `cc-switch`
- Uses random profile selection by default for fast startup
- Supports optional Codex quota-aware routing via `max-remaining-5h`
- Isolates `cclaude` runtime settings from `~/.claude/settings.json`
- Provides `init` and `doctor` for onboarding and diagnostics
- Uses a fixed global config path instead of scanning the current project directory

## Installation

Install the latest packaged release directly from GitHub:

```bash
npm install -g https://github.com/steven-ld/cc-launcher/releases/latest/download/cc-launcher.tgz
```

This installs the latest release artifact directly. Users do not need to clone the repository or install from source.

After installation, the primary commands are:

```bash
ccodex doctor
ccodex init
ccodex list
ccodex run -- --help
```

For Claude:

```bash
cclaude doctor
cclaude init
cclaude run
```

## Quick Start

### 1. Prepare `cc-switch`

`CC Launcher` expects the local profile database at:

```text
~/.cc-switch/cc-switch.db
```

Before first use, make sure:

1. `cc-switch` is installed
2. you have signed in through `cc-switch`
3. the local database has been created successfully

If the database is missing, `doctor` and `init` will print clear installation guidance.

### 2. Verify the environment

```bash
ccodex doctor
```

A healthy environment should report:

- the command is installed
- the default database is available
- importable profiles are present
- the launcher is ready to run

### 3. Start using it

```bash
ccodex list
ccodex pick
ccodex run -- --help
ccodex usage --json
```

## Commands

`CC Launcher` currently exposes the following commands:

- `init`
- `doctor`
- `list`
- `pick`
- `run`
- `usage`

Command semantics:

- `init`: first-run guidance and readiness verification
- `doctor`: checks command availability, config, database, and provider import status
- `list`: prints available profiles
- `pick`: shows which profile would be selected
- `run`: launches the target CLI with the selected profile
- `usage`: reads official Codex rate-limit data; available only on `ccodex`

## Configuration

In the default path, no manual config file is required.

If you want to override runtime behavior, use the fixed global config file:

```text
~/.cc-launcher/config.json
```

Typical reasons to add this file:

- override `runtimeRoot`
- override the shared home directory
- change selection strategy
- override the default `cc-switch` database path
- use static profiles instead of `cc-switch`

By default, `CC Launcher` no longer auto-scans local files such as `pool.local.json` in the current repository.

### Minimal Config

```json
{
  "version": 1,
  "codexCommand": "codex",
  "runtimeRoot": "~/.cc-launcher/runtime",
  "sharedCodexHome": "~/.codex",
  "sharedHomeEntries": ["AGENTS.md", "skills", "prompts", "rules"],
  "selection": {
    "strategy": "random"
  },
  "profileSource": {
    "type": "cc-switch",
    "appType": "codex"
  }
}
```

If your database lives elsewhere:

```json
{
  "profileSource": {
    "type": "cc-switch",
    "appType": "codex",
    "dbPath": "/absolute/path/to/cc-switch.db"
  }
}
```

### Optional Quota-Aware Routing

The default strategy is `random`.

If you are willing to trade startup latency for smarter official Codex routing, set:

```json
{
  "selection": {
    "strategy": "max-remaining-5h"
  }
}
```

This mode probes official Codex auth-based profiles and selects the one with the highest remaining quota in the 5-hour window. It does not apply to `cclaude` or non-official env-only providers.

### Static Profiles

If you do not want to use `cc-switch`, you can still provide static profiles explicitly via `--pool-config`:

```json
{
  "version": 1,
  "runtimeRoot": "~/.cc-launcher/runtime",
  "profiles": [
    {
      "name": "work",
      "authFile": "/absolute/path/auth.work.json"
    },
    {
      "name": "personal",
      "authFile": "/absolute/path/auth.personal.json"
    }
  ]
}
```

## Release

Release packaging is automated through GitHub Actions.

Maintainers can cut a new version locally with one of the following commands:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

Each command will:

1. run the full test suite
2. bump `package.json` version with a Git tag such as `v0.2.1`
3. push `master` and the new tag to GitHub
4. trigger the Release workflow
5. publish both `cc-launcher-<version>.tgz` and the stable `cc-launcher.tgz` asset to GitHub Releases

The stable asset makes this install command permanent:

```bash
npm install -g https://github.com/steven-ld/cc-launcher/releases/latest/download/cc-launcher.tgz
```

## Troubleshooting

### `~/.cc-switch/cc-switch.db` was not found

Check the following first:

1. `cc-switch` is installed
2. sign-in has completed successfully
3. the database is present at the default path

If the database is in a custom location, pass it explicitly:

```bash
ccodex doctor --pool-source-db /absolute/path/to/cc-switch.db
```

### A local repository config was used unexpectedly

Current versions no longer auto-scan the working directory for `pool.local.json`. If you want to use a local config intentionally, pass it explicitly:

```bash
ccodex run --pool-config /absolute/path/to/config.json -- --help
```

### `cclaude` still uses the wrong provider

`cclaude` now isolates user-level settings by default. If the selected model or gateway is still wrong, inspect the provider data stored in `cc-switch` itself.

## Development

For local development:

```bash
npm test
npm run codex -- doctor
npm run codex -- list
npm run codex -- run -- --help
```

For end users, the supported entrypoints remain:

```bash
ccodex ...
cclaude ...
```
