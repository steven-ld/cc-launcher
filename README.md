# CC Launcher: Account Pool Launcher for Codex & Claude

`CC Launcher` 把 `cc-switch` 的多账号变成一个可轮换、可一键启动的 `Codex` / `Claude` 产品入口。

它主要解决两个实际问题：
- 单个账号额度不够用，容易很快打满
- 在 `cc-switch` 里频繁手动切账号，使用成本高

## 核心功能

- **自动选路**：默认按 5h 剩余额度自动选择最优账号
- **额度缓存**：后台定时刷新所有账号额度，无需每次 live probe
- **智能负载**：跳过额度耗尽或认证失败的账号，30 分钟后自动恢复
- **零配置**：直接读取 `~/.cc-switch/cc-switch.db`，无需额外配置

## 安装

```bash
npm install -g https://github.com/steven-ld/cc-launcher/releases/latest/download/cc-launcher.tgz
```

## 快速开始

```bash
ccodex doctor   # 检查环境
ccodex list     # 查看所有账号
ccodex status   # 查看账号启用/禁用状态
ccodex cache    # 查看额度缓存
ccodex          # 默认启动，自动选路
```

## Codex 命令

| 命令 | 说明 |
|------|------|
| `ccodex doctor` | 检查环境 |
| `ccodex list` | 查看所有账号 |
| `ccodex status` | 查看账号启用/禁用状态 |
| `ccodex cache` | 查看额度缓存 |
| `ccodex pick` | 查看当前选中账号 |
| `ccodex proxy` | 启动 WebSocket 代理 |
| `ccodex run` | 启动 Codex |
| `ccodex usage` | 查看官方额度 |
| `ccodex disable --pool-profile xxx` | 禁用某账号 |
| `ccodex enable --pool-profile xxx` | 启用某账号 |

## Claude 命令

| 命令 | 说明 |
|------|------|
| `cclaude doctor` | 检查环境 |
| `cclaude list` | 查看所有账号 |
| `cclaude status` | 查看账号启用/禁用状态 |
| `cclaude proxy` | 启动 HTTP 代理 |
| `cclaude run` | 启动 Claude |
| `cclaude disable --pool-profile xxx` | 禁用某账号 |
| `cclaude enable --pool-profile xxx` | 启用某账号 |

## 代理地址

- **Claude**: `http://127.0.0.1:15722`
- **Codex**: `ws://127.0.0.1:15721`

## 故障排查

### Windows 上报 "spawn xxx ENOENT"
确保 Node.js 版本 >= 18.0.0（已支持 Windows）

### 账号一直用同一个
可能是其他账号额度耗尽或认证失败，用 `ccodex status` 查看

## 开发

详见 [DEVELOPMENT.md](./DEVELOPMENT.md)
