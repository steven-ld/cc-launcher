# Contributing to CC Launcher

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the repo
git clone https://github.com/steven-ld/cc-launcher.git
cd cc-launcher

# Install dependencies
npm install

# Run tests
npm test

# Run tests with verbose output
npm test -- --test-name-pattern="your test"

# Run a specific test file
node --test test/cli.test.js
```

## Project Structure

- `src/cli.js` — CLI entry point, argument parsing, command routing
- `src/pool-config.js` — Account pool configuration loading
- `src/profile-selection.js` — Selection strategy (random / max-remaining-5h)
- `src/profile-state.js` — Profile disable/enable state management
- `src/rate-limit-cache.js` — Rate limit cache + CC Cloud usability probe
- `src/proxy-server.js` — WebSocket (Codex) and HTTP (Claude) proxy servers
- `src/app-context.js` — CLI context detection (codex vs claude)
- `src/runtime-home.js` — Runtime directory management

## Code Style

- ESM modules (`import` / `export`)
- Node.js built-in APIs only (no external dependencies except cc-switch)
- Use `node --check` to verify syntax before committing
- Keep functions small and focused

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add cclaude cache command
fix: handle timeout in probeProfileRateLimit
docs: update README with new commands
refactor: extract ProbeError class
test: add coverage for profile-state exponential backoff
```

## Testing

- Use Node.js built-in `node:test`
- Each test file should be self-contained (use temp directories)
- Mock cc-switch database in tests, don't depend on real user data
- Target: core logic (`profile-selection.js`, `pool-config.js`) ≥ 80% coverage

## Opening a Pull Request

1. Fork the repo and create a branch from `master`
2. Write your code and add tests
3. Ensure all tests pass: `npm test`
4. Open a PR with a clear description of what changed and why
5. Link any related issues

## Reporting Bugs

Please include:
- Node.js version (`node --version`)
- OS (macOS / Linux / Windows)
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output (`ccodex run 2>&1`)

## Suggesting Features

Open a [GitHub Discussion](https://github.com/steven-ld/cc-launcher/discussions) → Feature Requests
