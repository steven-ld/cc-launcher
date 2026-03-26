# DEVELOPMENT

这个文件面向维护者，不面向普通使用者。

## 本地开发

常用命令：

```bash
npm test
npm run codex -- doctor
npm run codex -- list
npm run codex -- run -- --help
```

## 配置设计

默认情况下产品直接读取：

```text
~/.cc-switch/cc-switch.db
```

如果需要覆盖默认行为，使用固定的全局配置文件：

```text
~/.cc-launcher/config.json
```

适合写配置的场景：

- 自定义 `runtimeRoot`
- 自定义共享 home
- 覆盖默认数据库路径
- 修改选路策略
- 使用静态 profile，而不是 `cc-switch`

最小配置示例：

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

## 可选选路策略

默认策略是 `random`。

如果需要按官方额度优先选择 Codex profile：

```json
{
  "selection": {
    "strategy": "max-remaining-5h"
  }
}
```

这个模式只适用于官方 Codex auth 型 profile，不适用于 `cclaude` 或非官方 env-only provider。

## 静态 Profile

如果不依赖 `cc-switch`，可以显式传入静态配置：

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

使用方式：

```bash
ccodex run --pool-config /absolute/path/to/config.json -- --help
```

## 发布

发布通过 GitHub Actions 自动完成。

本地发版命令：

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

发版流程会自动执行：

1. 运行测试
2. bump `package.json` 版本
3. 创建并推送 tag
4. 触发 GitHub Release workflow
5. 上传两个 Release 资产：
   `cc-launcher-<version>.tgz`
   `cc-launcher.tgz`

稳定安装地址：

```bash
npm install -g https://github.com/steven-ld/cc-launcher/releases/latest/download/cc-launcher.tgz
```
