# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | ✅ Currently supported |

## Reporting a Vulnerability

If you discover a security vulnerability within CC Launcher, please report it responsibly.

**Do NOT open a public GitHub Issue for security vulnerabilities.**

Instead, please send a private report:

1. Go to [Security Advisories](https://github.com/steven-ld/cc-launcher/security/advisories/new)
2. Select **Report a vulnerability**
3. Provide details:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes (optional)

I aim to acknowledge reports within 48 hours and provide a timeline for remediation.

## What to Expect

- I will acknowledge your report within 48 hours
- I'll keep you updated on the progress
- Once fixed, I'll credit you in the release notes (unless you prefer anonymity)
- For critical vulnerabilities, I may request a CVE assignment

## Scope

CC Launcher handles:
- Local API keys stored on disk (`~/.cc-switch/cc-switch.db`, `~/.cc-launcher/`)
- Network proxying between local clients and upstream AI APIs
- Spawning external CLI processes (Codex / Claude)

If you find an issue with any of these, please report it.
