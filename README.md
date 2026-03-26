# CC Launcher

`CC Launcher` 是一个基于 `cc-switch` 的 CLI 启动器，用于统一管理并启动 `Codex` 与 `Claude` 的多账号环境。

安装后会直接提供两个稳定入口：

- `ccodex`
- `cclaude`

项目目标很明确：

- 以 `cc-switch` 作为默认数据源
- 默认零配置可用
- 避免与系统已有 `codex` / `claude` 命令重名
- 将产品级配置固定收口，而不是散落在各个项目目录

## Features

- 默认自动发现 `~/.cc-switch/cc-switch.db`
- 默认直接从 `cc-switch` 导入可用 provider
- 默认随机选路，启动开销最小
- 可选启用 Codex 官方 5 小时窗口剩余额度优先策略
- `cclaude` 运行时隔离用户级 settings，避免被全局 provider 配置覆盖
- 提供 `init` 与 `doctor`，用于安装后引导和环境诊断
- 默认不再扫描当前工作目录中的 `pool.local.json`

## Installation

```bash
npm install -g cc-launcher
```

安装完成后，直接使用：

```bash
ccodex doctor
ccodex init
ccodex list
ccodex run -- --help
```

如果要启动 Claude：

```bash
cclaude doctor
cclaude init
cclaude run
```

## Quick Start

### 1. 准备 `cc-switch`

`CC Launcher` 默认依赖本地数据库：

```text
~/.cc-switch/cc-switch.db
```

首次使用前请确认：

1. 已安装 `cc-switch`
2. 已完成登录，并成功生成本地数据库

如果数据库不存在，`doctor` 和 `init` 会直接给出安装提示。

### 2. 运行诊断

```bash
ccodex doctor
```

理想情况下你会看到：

- 命令已安装
- 默认数据库可访问
- 可导入 profile 数量正常
- 当前环境已具备运行条件

### 3. 直接启动

```bash
ccodex list
ccodex pick
ccodex run -- --help
ccodex usage --json
```

对大多数场景来说，到这里已经够用了。

## Commands

`CC Launcher` 当前提供以下核心命令：

- `init`
- `doctor`
- `list`
- `pick`
- `run`
- `usage`

说明如下：

- `init`：首次安装后的引导式确认
- `doctor`：检查命令、配置、数据库与 provider 可用性
- `list`：列出当前可用 profile
- `pick`：显示本次将要使用的 profile
- `run`：以选中的 profile 启动目标 CLI
- `usage`：读取 Codex 官方额度信息，仅 `ccodex` 支持

## Configuration

默认情况下不需要手工配置文件。

如果你需要覆盖默认行为，例如：

- 指定运行时目录
- 指定共享 home
- 修改选路策略
- 覆盖默认 `cc-switch` 数据库路径
- 在不依赖 `cc-switch` 的情况下手工维护 profile

请使用固定的全局产品配置文件：

```text
~/.cc-launcher/config.json
```

默认不会再自动扫描当前项目目录中的 `pool.local.json` 或 `config/pool.json`。

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

如果数据库不在默认位置：

```json
{
  "profileSource": {
    "type": "cc-switch",
    "appType": "codex",
    "dbPath": "/absolute/path/to/cc-switch.db"
  }
}
```

### Optional Strategy

默认策略是 `random`。

如果你愿意牺牲启动速度，`ccodex` 可以切换到基于官方额度的选路策略：

```json
{
  "selection": {
    "strategy": "max-remaining-5h"
  }
}
```

该模式只探测官方 Codex auth 型 profile，并按 5 小时窗口剩余额度选择。`cclaude` 与非官方 env-only provider 不参与这一排序。

### Static Profiles

如果你完全不想依赖 `cc-switch`，也可以继续使用静态 profile；建议显式通过 `--pool-config` 指向配置文件，而不是依赖自动发现：

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

## Runtime Behavior

### `ccodex`

- 默认从 `cc-switch` 导入 Codex provider
- 默认随机选择 profile
- 可选读取官方额度并按剩余额度优先
- `usage` 可读取官方 live 或 cached snapshot

### `cclaude`

- 默认从 `cc-switch` 导入 Claude provider
- 运行时会注入隔离后的 settings 文件
- 默认不会继续继承 `~/.claude/settings.json` 中的全局 provider 绑定

## Troubleshooting

### 没找到 `~/.cc-switch/cc-switch.db`

优先检查：

1. `cc-switch` 是否已安装
2. 是否已经在 `cc-switch` 中完成登录
3. 数据库是否位于默认路径

如果数据库在自定义位置，可显式传入：

```bash
ccodex doctor --pool-source-db /absolute/path/to/cc-switch.db
```

### 在仓库目录启动时误读本地测试配置

当前版本默认不会自动扫描工作目录中的 `pool.local.json`。如果你仍然希望使用某份本地配置，应该显式传入：

```bash
ccodex run --pool-config /absolute/path/to/config.json -- --help
```

### `cclaude` 总是落到错误 provider

`cclaude` 已默认隔离用户级 settings。如果结果仍然不对，优先检查对应 provider 本身是否就在 `cc-switch` 数据里写入了目标模型或网关环境变量。

## Development

仓库内调试可使用：

```bash
npm test
npm run codex -- doctor
npm run codex -- list
npm run codex -- run -- --help
```

面向最终用户时，推荐始终使用 npm 暴露的 bin：

```bash
ccodex ...
cclaude ...
```
