# CC Launcher —智能账号池启动器

> 将 cc-switch 多账号变成可轮换、可一键启动的 Codex / Claude 产品入口。

<!-- Badges -->
[![CI](https://github.com/steven-ld/cc-launcher/actions/workflows/release.yml/badge.svg)](https://github.com/steven-ld/cc-launcher/actions)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D%2022-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](./LICENSE)

<!-- Quick demo: ANSI art + demo flow -->
```
$ ccodex status
● official-a  ████████░░  82% remaining  enabled
● official-b  ██████░░░░  61% remaining  enabled
● glm-proxy   ✅ usable                   enabled
$ ccodex
[cc-launcher] selected official profile by 5h remaining: 82% remaining.
[cc-launcher] launching: codex ...
```

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| **自动选路** | Codex 按 5h 剩余额度选最优账号，Claude 按可用性检测 |
| **额度缓存** | 后台定时刷新，无需每次 live probe |
| **智能负载** | 跳过额度耗尽或认证失败的账号，自动指数退避恢复 |
| **零配置** | 直接读取 `~/.cc-switch/cc-switch.db`，无需额外配置 |
| **双入口** | `ccodex`（Codex）和 `cclaude`（Claude）独立命令 |
| **指数退避** | 失败后按类型分级等待：认证失败 30→60→180min，网络抖动 5→15→30min |
| **配置热重载** | 支持 SIGHUP 信号重载配置 |

---

## 📦 安装

```bash
# 推荐：GitHub Release tarball
npm install -g https://github.com/steven-ld/cc-launcher/releases/latest/download/cc-launcher.tgz

# 或者：本地安装
npm install -g /path/to/cc-launcher
```

**要求**：Node.js ≥ 22

---

## 🚀 快速开始

```bash
# 检查环境
ccodex doctor
cclaude doctor

# 查看所有账号
ccodex list
cclaude list

# 查看账号启用/禁用状态
ccodex status
cclaude status

# 查看额度缓存（Codex）
ccodex cache

# 手动禁用/启用某账号
ccodex disable --pool-profile official-a
ccodex enable  --pool-profile official-a

# 默认启动（自动选路）
ccodex
cclaude

# 强制使用指定账号
ccodex --pool-profile official-b
cclaude --pool-profile glm-proxy
```

---

## ⚡ 命令参考

### ccodex（Codex 入口）

| 命令 | 说明 |
|------|------|
| `ccodex doctor` | 检查环境 |
| `ccodex list` | 查看所有账号 |
| `ccodex status` | 查看启用/禁用状态 |
| `ccodex cache` | 查看额度缓存 |
| `ccodex cache --refresh` | 强制刷新缓存 |
| `ccodex pick` | 查看当前选中账号 |
| `ccodex proxy` | 启动 WebSocket 代理 |
| `ccodex run` | 启动 Codex |
| `ccodex usage` | 查看官方额度 |
| `ccodex disable --pool-profile <name>` | 禁用账号 |
| `ccodex enable --pool-profile <name>` | 启用账号 |

### cclaude（Claude 入口）

| 命令 | 说明 |
|------|------|
| `cclaude doctor` | 检查环境 |
| `cclaude list` | 查看所有账号 |
| `cclaude status` | 查看启用/禁用状态 |
| `cclaude proxy` | 启动 HTTP 代理 |
| `cclaude run` | 启动 Claude |
| `cclaude disable --pool-profile <name>` | 禁用账号 |
| `cclaude enable --pool-profile <name>` | 启用账号 |

### 代理地址

| 服务 | 地址 |
|------|------|
| **Claude** | `http://127.0.0.1:15722` |
| **Codex** | `ws://127.0.0.1:15721` |

---

## 🔧 高级配置

### 配置文件

默认配置：`~/.cc-launcher/config.json`

```json
{
  "version": 1,
  "runtimeRoot": "~/.cc-launcher/runtime",
  "selection": {
    "strategy": "max-remaining-5h"
  },
  "profiles": []
}
```

### 选路策略

| 策略 | 说明 |
|------|------|
| `max-remaining-5h` | Codex：选择 5h 窗口剩余额度最多的账号 |
| `random` | 随机轮换 |

### 本地账号池

可通过 `--pool-config` 指定本地配置文件，跳过 cc-switch 数据库：

```bash
ccodex run --pool-config ./pool.local.json
```

---

## 🔍 故障排查

### Windows 上报 "spawn xxx ENOENT"
确保 Node.js ≥ 18.0.0

### 账号一直用同一个
可能是其他账号额度耗尽或认证失败：
```bash
ccodex status   # 查看禁用状态
ccodex enable --pool-profile <name>  # 手动启用
```

### Claude 代理返回错误
用 `cclaude doctor` 检查各账号可用性：
```bash
cclaude cache --refresh  # 刷新可用性缓存
```

### 查看详细日志
```bash
ccodex run --pool-bin ./my-codex 2>&1 | grep -i error
```

---

## 📁 项目结构

```
src/
├── cli.js              # CLI 入口 + 参数解析
├── pool-config.js      # 账号池配置解析
├── profile-selection.js # 选路策略
├── profile-state.js    # 账号禁用状态管理
├── rate-limit-cache.js # 额度缓存 + CC Cloud 可用性检测
├── proxy-server.js     # WebSocket / HTTP 代理服务器
├── app-context.js      # CLI 环境检测
├── runtime-home.js     # 运行时目录管理
└── cc-switch/          # cc-switch 数据库读取
test/
├── cli.test.js
├── proxy.test.js
├── cc-switch.test.js
└── rate-limits.test.js
```

---

## 🤝 贡献

欢迎提交 Issue 和 PR！详见 [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 📄 许可证

MIT © steven-ld
