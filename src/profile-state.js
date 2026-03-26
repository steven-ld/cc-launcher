import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_STATE_FILE = "~/.cc-launcher/profile-state.json";
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown after failure

function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export class ProfileStateManager {
  constructor(options = {}) {
    this.stateFile = expandHome(options.stateFile ?? DEFAULT_STATE_FILE);
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.state = {
      disabled: {}, // profileName -> { disabledAt, reason }
    };
    this._loaded = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      this.state = JSON.parse(raw);
    } catch {
      // File doesn't exist, use empty state
      this.state = { disabled: {} };
    }
    this._loaded = true;
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
  }

  isDisabled(profileName) {
    const entry = this.state.disabled[profileName];
    if (!entry) return false;

    // Check if cooldown has passed
    const elapsed = Date.now() - entry.disabledAt;
    if (elapsed >= this.cooldownMs) {
      // Cooldown expired, re-enable
      delete this.state.disabled[profileName];
      this.save().catch(() => {});
      return false;
    }

    return true;
  }

  disable(profileName, reason = "unknown") {
    this.state.disabled[profileName] = {
      disabledAt: Date.now(),
      reason: reason,
    };
    this.save().catch(() => {});
  }

  enable(profileName) {
    delete this.state.disabled[profileName];
    this.save().catch(() => {});
  }

  getDisabledProfiles() {
    const disabled = [];
    for (const [name, entry] of Object.entries(this.state.disabled)) {
      const elapsed = Date.now() - entry.disabledAt;
      const remaining = Math.max(0, this.cooldownMs - elapsed);
      disabled.push({
        name,
        reason: entry.reason,
        remainingMs: remaining,
        disabledAt: entry.disabledAt,
      });
    }
    return disabled;
  }

  filterEnabled(profiles) {
    return profiles.filter((p) => !this.isDisabled(p.name));
  }
}

// Singleton
let globalStateManager = null;

export function getProfileStateManager(options = {}) {
  if (!globalStateManager) {
    globalStateManager = new ProfileStateManager(options);
  }
  return globalStateManager;
}
