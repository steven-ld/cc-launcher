# CC Launcher: Account Pool Launcher for Codex & Claude

`CC Launcher` 把 `cc-switch` 的多账号变成一个可轮换、可一键启动的 `Codex` / `Claude` 产品入口。

它主要解决两个实际问题：

- 单个账号额度不够用，容易很快打满
- 在 `cc-switch` 里频繁手动切账号，使用成本高

安装之后，你不需要每次先去 `cc-switch` 手切当前账号，再回到命令行重新启动工具。`CC Launcher` 会直接从 `cc-switch` 读取可用 provider，并以轮换池的方式帮你启动：

- `ccodex`
- `cclaude`

## 它解决了什么问题

如果你平时有多个 Codex / Claude 账号，常见问题通常是：

- 一个账号很快就用完了
- 账号之间需要来回切换
- 当前到底切到了哪个账号，不够直观
- 本地项目里容易残留测试配置，影响正常使用

`CC Launcher` 的目标就是把这些动作收成一个稳定的产品入口：

- 默认直接读取 `~/.cc-switch/cc-switch.db`
- 默认零配置可用
- 默认不扫描当前目录里的本地测试配置
- 用统一命令完成查看、选择和启动

## 核心功能

- 自动发现 `~/.cc-switch/cc-switch.db`
- 自动导入 Codex / Claude provider
- 把多个账号作为轮换池使用，而不是手动来回切换
- `ccodex` 默认随机选路，优先保证启动速度
- `ccodex` 支持查看官方额度使用情况
- `cclaude` 运行时隔离全局 Claude settings
- 支持通过 GitHub Release 直接安装最新包

## 安装

直接安装最新发布包：

```bash
npm install -g https://github.com/steven-ld/cc-launcher/releases/latest/download/cc-launcher.tgz
```

安装完成后建议先检查环境：

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

- `doctor`：检查命令、数据库和账号池是否可用
- `list`：查看当前导入了哪些账号
- `pick`：查看当前会选中哪个账号
- `run`：按当前选中的账号启动目标 CLI
- `usage`：查看 Codex 官方额度，只支持 `ccodex`

补充说明：

- `ccodex usage --json` 默认会自动选择一个可用的官方 Codex 账号
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

如果你确实要使用某份本地配置，请显式传入：

```bash
ccodex run --pool-config /absolute/path/to/config.json -- --help
```

### 为什么 `cclaude` 看起来总落到同一个 provider

`cclaude` 运行时已经默认隔离用户级 settings。如果结果仍然不对，优先检查 `cc-switch` 中该 provider 本身写入的模型或网关环境变量。

## 开发与发布

开发、配置、测试和发布说明已移到：

- [DEVELOPMENT.md](./DEVELOPMENT.md)
