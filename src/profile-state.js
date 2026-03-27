import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_STATE_FILE = "~/.cc-launcher/profile-state.json";

// --- Probe error kinds for exponential backoff ---
/**
 * @typedef {"auth" | "network" | "model_error" | "unknown" | "manual"} DisableReason
 */

// Backoff schedule: [cooldownMs, label]
// auth failures: 30min → 60min → 180min
const AUTH_BACKOFF_MS = [30, 60, 180].map((m) => m * 60 * 1000);
// network / model_error: 5min → 15min → 30min
const NETWORK_BACKOFF_MS = [5, 15, 30].map((m) => m * 60 * 1000);
// manual / unknown: fixed 30min
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function getCooldownForKind(kind) {
  if (kind === "auth") return AUTH_BACKOFF_MS;
  if (kind === "network" || kind === "model_error") return NETWORK_BACKOFF_MS;
  return [DEFAULT_COOLDOWN_MS];
}

export class ProfileStateManager {
  constructor(options = {}) {
    this.stateFile = expandHome(options.stateFile ?? DEFAULT_STATE_FILE);
    this.state = {
      disabled: {}, // profileName -> { disabledAt, reason, failureCount, failureKind }
    };
    this._loaded = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      this.state = JSON.parse(raw);
      // Ensure nested structure is correct after load
      if (!this.state.disabled) {
        this.state.disabled = {};
      }
    } catch {
      this.state = { disabled: {} };
    }
    this._loaded = true;
  }

  async save() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
  }

  /**
   * Returns the effective cooldown for this profile based on its failure kind and count.
   * Returns null if the profile is not disabled.
   * @param {string} profileName
   * @returns {{ remainingMs: number, reason: string, kind: string } | null}
   */
  getDisabledInfo(profileName) {
    const entry = this.state.disabled[profileName];
    if (!entry) return null;

    const cooldownMs = this._getCooldownForEntry(entry);
    const elapsed = Date.now() - entry.disabledAt;
    const remainingMs = Math.max(0, cooldownMs - elapsed);

    return {
      remainingMs,
      reason: entry.reason,
      kind: entry.failureKind ?? "unknown",
      failureCount: entry.failureCount ?? 1,
    };
  }

  isDisabled(profileName) {
    const info = this.getDisabledInfo(profileName);
    return info !== null && info.remainingMs > 0;
  }

  /**
   * Disable a profile with exponential backoff.
   * @param {string} profileName
   * @param {string} reason
   * @param {DisableReason} [kind] - inferred failure kind
   */
  disable(profileName, reason = "unknown", kind = "unknown") {
    const existing = this.state.disabled[profileName];

    // Determine failure count and kind
    let failureCount = 1;
    let failureKind = kind;

    if (existing) {
      // Same kind: increment counter
      if (existing.failureKind === kind) {
        failureCount = (existing.failureCount ?? 1) + 1;
      } else {
        // Kind changed: reset counter
        failureCount = 1;
        failureKind = kind;
      }
    }

    this.state.disabled[profileName] = {
      disabledAt: Date.now(),
      reason,
      failureCount,
      failureKind,
    };
    this.save().catch(() => {});
  }

  enable(profileName) {
    delete this.state.disabled[profileName];
    this.save().catch(() => {});
  }

  /**
   * Returns profiles that are currently disabled, with remaining retry time.
   * @returns {{ name: string, reason: string, remainingMs: number, kind: string, failureCount: number }[]}
   */
  getDisabledProfiles() {
    const disabled = [];
    for (const [name, entry] of Object.entries(this.state.disabled)) {
      const cooldownMs = this._getCooldownForEntry(entry);
      const elapsed = Date.now() - entry.disabledAt;
      const remainingMs = Math.max(0, cooldownMs - elapsed);
      if (remainingMs > 0) {
        disabled.push({
          name,
          reason: entry.reason,
          remainingMs,
          kind: entry.failureKind ?? "unknown",
          failureCount: entry.failureCount ?? 1,
        });
      } else {
        // Cooldown expired; auto-clear
        delete this.state.disabled[name];
      }
    }
    return disabled;
  }

  filterEnabled(profiles) {
    return profiles.filter((p) => !this.isDisabled(p.name));
  }

  // --- private helpers ---

  /**
   * @param {{ failureKind?: string, failureCount?: number }} entry
   * @returns {number} cooldown in ms
   */
  _getCooldownForEntry(entry) {
    const kind = entry.failureKind ?? "unknown";
    const count = entry.failureCount ?? 1;
    const schedule = getCooldownForKind(kind);
    const index = Math.min(count - 1, schedule.length - 1);
    return schedule[index];
  }
}

// Singleton (shared instance per process)
let globalStateManager = null;

export function getProfileStateManager(options = {}) {
  if (!globalStateManager) {
    globalStateManager = new ProfileStateManager(options);
  }
  return globalStateManager;
}
