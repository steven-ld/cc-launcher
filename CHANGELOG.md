# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- *(nothing yet)*

## [0.2.6] — 2026-03-26

### Added
- **CC Cloud 可用性检测**：Claude 入口支持按「能返回 + 无模型错误」判断账号可用性，不再探测非标准额度接口
- **结构化 ProbeError**：探测错误按类型分类（`auth` / `timeout` / `network` / `model_error` / `protocol` / `unknown`），便于排查问题
- **指数退避禁用策略**：账号禁用按失败类型分级等待：
  - 认证失败：30min → 60min → 180min
  - 网络抖动 / 模型错误：5min → 15min → 30min
  - 手动 / 未知：固定 30min
- **缓存实例隔离**：按 `configDir` 分组缓存实例，不同工作目录不再互相污染
- **SIGHUP 配置热重载**：运行时收到 SIGHUP 信号可重新加载账号状态和缓存刷新

### Fixed
- `max-remaining-5h` 选路策略在缓存存在时信任过期数据的问题（加入 `!entry.snapshot` 跳过 CC Cloud 条目）

### Changed
- `cclaude proxy` 启动时不再无差别探测所有账号（避免对非标准 provider 发送无效请求），探测仅在 `cclaude cache --refresh` 时触发

## [0.2.5] — 2026-03-26

### Fixed
- 修复 Windows 上 `.cmd` 文件无法启动的问题（添加 `shell: true`）

## [0.2.4] — 2026-03-26

### Changed
- 优化 cc-switch 数据库读取性能

## [0.2.3] — 2026-03-26

### Added
- `ccodex usage` 命令：查看官方额度报告
- `ccodex cache --refresh` 命令：强制刷新额度缓存

## [0.2.2] — 2026-03-26

### Added
- 初始版本：支持 ccodex 和 cclaude 双入口
- 自动选路（max-remaining-5h / random）
- WebSocket 代理（Codex）和 HTTP 代理（Claude）
- 账号禁用/启用管理
