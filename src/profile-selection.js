import {
  MAX_REMAINING_5H_SELECTION_STRATEGY,
  RANDOM_SELECTION_STRATEGY,
  getConfigStrategy,
  pickProfile,
} from "./pool-config.js";
import { getFiveHourRemainingPercent } from "./rate-limit-cache.js";
import { getRateLimitCache } from "./rate-limit-cache.js";
import { getProfileStateManager } from "./profile-state.js";

// Re-export pickProfile for consumers that need full proxy-command probing
export { pickProfile } from "./pool-config.js";

export const CC_CLOUD_USABLE_STRATEGY = "cc-cloud-usable";
export const MAX_REMAINING_5H_SELECTION_STRATEGY_ORIG = MAX_REMAINING_5H_SELECTION_STRATEGY;

function isOfficialCodexProbeCandidate(profile) {
  return Boolean(profile?.auth || profile?.authFile);
}

function byRemainingDescending(left, right) {
  if (right.remaining5hPercent !== left.remaining5hPercent) {
    return right.remaining5hPercent - left.remaining5hPercent;
  }
  if (right.index !== left.index) {
    return left.index - right.index;
  }
  return 0;
}

function fallbackToRandom(config) {
  return pickProfile({
    ...config,
    selection: {
      strategy: RANDOM_SELECTION_STRATEGY,
    },
  });
}

function resolveEffectiveStrategy(config, cliContext) {
  if (cliContext.appType === "claude") {
    // For CC Cloud / Claude: always use usable-based strategy
    return CC_CLOUD_USABLE_STRATEGY;
  }
  return getConfigStrategy(config);
}

export async function selectLaunchProfile({
  configDir,
  config,
  cliContext,
  profileName,
  launchCommand,
  cwd = process.cwd(),
  allowLiveProbe = true,
}) {
  if (profileName) {
    return {
      profile: pickProfile(config, { profileName }),
      diagnostics: { mode: "explicit" },
    };
  }

  const stateManager = getProfileStateManager();
  const enabledProfiles = stateManager.filterEnabled(config.profiles);
  const disabledProfiles = config.profiles.filter((p) => !enabledProfiles.includes(p));

  if (enabledProfiles.length === 0) {
    throw new Error(
      "All profiles are currently disabled due to failures. Please wait and try again.",
    );
  }

  // Create a filtered config for selection
  const filteredConfig = { ...config, profiles: enabledProfiles };

  const strategy = resolveEffectiveStrategy(config, cliContext);

  // ── CC Cloud usable strategy ──────────────────────────────────────────────
  if (strategy === CC_CLOUD_USABLE_STRATEGY) {
    const cache = getRateLimitCache({
      configDir: configDir || cwd || process.cwd(),
      codexCommand: launchCommand,
    });

    // Load cache first
    if (!cache.cache) {
      await cache.load();
    }

    const cacheAge = cache.cache?.updatedAt ? Date.now() - cache.cache.updatedAt : Infinity;
    const needsRefresh = cacheAge > 5 * 60 * 1000;

    // Refresh in background if stale
    if (needsRefresh) {
      cache.refreshProfiles(enabledProfiles, { appType: "claude" }).catch(() => {});
    }

    // Try to find a usable profile from cache
    const cachedBest = cache.getBestUsableProfile();

    if (cachedBest) {
      const matchedProfile = filteredConfig.profiles.find(
        (p) => p.name === cachedBest.profileName,
      );
      if (matchedProfile) {
        return {
          profile: matchedProfile,
          diagnostics: {
            mode: CC_CLOUD_USABLE_STRATEGY,
            usable: cachedBest.usable,
            httpStatus: cachedBest.httpStatus,
            reason: cachedBest.reason ?? null,
            source: cacheAge > 5 * 60 * 1000 ? "cache-stale" : "cache",
            cacheAgeMs: cacheAge,
            disabledProfiles: disabledProfiles.map((p) => p.name),
          },
        };
      }
    }

    // No cache — fall back to random (conservative; we don't know what's usable)
    return {
      profile: fallbackToRandom(filteredConfig),
      diagnostics: {
        mode: "random-fallback",
        reason: "no-cache",
        disabledProfiles: disabledProfiles.map((p) => p.name),
      },
    };
  }

  // ── Codex quota strategy ───────────────────────────────────────────────────
  // Use live probe results to select the profile with most remaining quota.
  // Start background refresh so subsequent calls are faster.
  const cache = getRateLimitCache({
    configDir: configDir || cwd || process.cwd(),
    codexCommand: launchCommand,
  });
  if (!cache.cache) {
    await cache.load();
  }
  const cacheAge = cache.cache?.updatedAt ? Date.now() - cache.cache.updatedAt : Infinity;
  if (cacheAge > 5 * 60 * 1000) {
    cache.refreshProfiles(enabledProfiles).catch(() => {});
  }

  // Find the profile with most remaining quota from probe results
  const bestFromCache = cache.getProfileWithMostRemaining();

  // Track failed probes for diagnostics
  const failedProbes = [];
  if (cache.cache?.profiles) {
    for (const entry of cache.cache.profiles) {
      if (!entry.snapshot && entry.profileName) {
        failedProbes.push(entry.profileName);
      }
    }
  }

  let selectedProfile;
  let selectedRemaining5hPercent = null;

  if (bestFromCache && bestFromCache.profileName) {
    // Match cached profile name to enabled profiles
    selectedProfile = filteredConfig.profiles.find(
      (p) => p.name === bestFromCache.profileName,
    );
    if (selectedProfile) {
      selectedRemaining5hPercent = getFiveHourRemainingPercent(bestFromCache.snapshot);
    }
  }

  // If no valid probe result from cache, probe profiles sequentially until we find a working one
  if (!selectedProfile && allowLiveProbe) {
    for (const profile of filteredConfig.profiles) {
      try {
        const result = await cache.refreshProfiles([profile]);
        const entry = result?.profiles?.[0];
        if (entry?.snapshot) {
          selectedProfile = profile;
          selectedRemaining5hPercent = getFiveHourRemainingPercent(entry.snapshot);
          break;
        } else {
          failedProbes.push(profile.name);
        }
      } catch (e) {
        failedProbes.push(profile.name);
      }
    }
  }

  // Final fallback to random if all probes failed
  if (!selectedProfile) {
    selectedProfile = fallbackToRandom(filteredConfig);
  }

  return {
    profile: selectedProfile,
    diagnostics: {
      mode: strategy === MAX_REMAINING_5H_SELECTION_STRATEGY
        ? MAX_REMAINING_5H_SELECTION_STRATEGY
        : RANDOM_SELECTION_STRATEGY,
      source: "live-probe",
      cacheAgeMs: cacheAge,
      selectedRemaining5hPercent,
      failedProbes,
      disabledProfiles: disabledProfiles.map((p) => p.name),
    },
  };
}

export function startRateLimitCacheRefresh(profiles, options = {}) {
  const stateManager = getProfileStateManager();
  const enabledProfiles = stateManager.filterEnabled(profiles);

  const cache = getRateLimitCache({
    ...options,
    configDir: options.configDir || process.cwd(),
  });

  cache.startBackgroundRefresh(enabledProfiles, {
    appType: options.appType ?? "codex",
  });

  return cache;
}

export function stopRateLimitCacheRefresh() {
  // Stop the current process-level cache instance (bound to cwd homedir).
  // Multi-instance cleanup is handled by process exit.
  try {
    const cache = getRateLimitCache({ configDir: process.cwd() });
    cache.stopBackgroundRefresh();
  } catch {
    // Best-effort
  }
}

export function getRateLimitCacheStatus() {
  const cache = getRateLimitCache();
  return cache.getStatus();
}
