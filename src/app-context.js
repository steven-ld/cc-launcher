import path from "node:path";

export const APP_CONTEXTS = {
  codex: {
    appType: "codex",
    cliName: "ccodex",
    command: "codex",
    sharedHome: "~/.codex",
    runtimeHomeEnvKey: "CODEX_HOME",
    supportsUsage: true,
    proxy: {
      protocol: "ws",
      host: "127.0.0.1",
      port: 15721,
    },
  },
  claude: {
    appType: "claude",
    cliName: "cclaude",
    command: "claude",
    sharedHome: "~/.claude",
    runtimeHomeEnvKey: null,
    supportsUsage: false,
    proxy: {
      protocol: "http",
      host: "127.0.0.1",
      port: 15722,
    },
  },
};

export function resolveAppContext(appType = "codex") {
  return APP_CONTEXTS[appType] ?? APP_CONTEXTS.codex;
}

export function detectCliContext(invokedPath = process.argv[1]) {
  const executableName = path.basename(invokedPath || "").replace(/\.js$/u, "");
  if (executableName === APP_CONTEXTS.claude.cliName) {
    return APP_CONTEXTS.claude;
  }

  return APP_CONTEXTS.codex;
}
