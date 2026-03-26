# CC Launcher

`CC Launcher` 是一个基于 `cc-switch` 的多账号 CLI 启动器，用来统一启动 `Codex` 和 `Claude`。

安装后会直接提供两个命令：

- `ccodex`
- `cclaude`

## 核心功能

- 自动发现 `~/.cc-switch/cc-switch.db`
- 自动导入 Codex / Claude provider
- 默认零配置可用
- 默认不扫描当前项目目录里的本地测试配置
- `cclaude` 运行时隔离全局 Claude settings
- 支持通过 GitHub Release 直接安装最新包

## 安装

直接安装最新发布包：

```bash
npm install -g https://github.com/steven-ld/cc-launcher/releases/latest/download/cc-launcher.tgz
```

安装后建议先检查环境：

```bash
ccodex doctor
cclaude doctor
```

## 使用前提

默认数据库路径是：

```text
~/.cc-switch/cc-switch.db
```

首次使用前请确认：

1. 已安装 `cc-switch`
2. 已通过 `cc-switch` 登录
3. 已成功生成本地数据库

如果数据库不存在，`doctor` 和 `init` 会给出明确提示。

## 快速开始

### Codex

```bash
ccodex doctor
ccodex list
ccodex pick
ccodex run -- --help
ccodex usage --json
```

### Claude

```bash
cclaude doctor
cclaude list
cclaude pick
cclaude run -- --help
```

## 常用命令

- `doctor`：检查命令、数据库和 profile 是否可用
- `list`：查看当前可用 profile
- `pick`：查看当前会选中的 profile
- `run`：按选中的 profile 启动目标 CLI
- `usage`：查看 Codex 官方额度，只支持 `ccodex`

补充说明：

- `ccodex usage --json` 默认会自动选择一个可用的官方 Codex profile
- 如果你想固定某个账号，再额外传 `--pool-profile`
- `cclaude` 不支持 `usage`

## 故障排查

### 没找到 `~/.cc-switch/cc-switch.db`

先检查：

1. `cc-switch` 是否已安装
2. 是否已经完成登录
3. 默认数据库路径下是否存在数据文件

如果数据库在自定义位置，可以显式指定：

```bash
ccodex doctor --pool-source-db /absolute/path/to/cc-switch.db
```

### 为什么项目目录里的本地配置没有生效

这是当前设计。默认不会自动扫描工作目录里的 `pool.local.json`。

如果你需要使用某份本地配置，请显式传入：

```bash
ccodex run --pool-config /absolute/path/to/config.json -- --help
```

### 为什么 `cclaude` 看起来总落到同一个 provider

`cclaude` 运行时已经默认隔离用户级 settings。如果结果仍然不对，优先检查 `cc-switch` 中该 provider 本身写入的模型或网关环境变量。

## 开发与发布

开发、配置、测试和发布说明已移到：

- [DEVELOPMENT.md](./DEVELOPMENT.md)
