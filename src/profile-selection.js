import { MAX_REMAINING_5H_SELECTION_STRATEGY, RANDOM_SELECTION_STRATEGY, getConfigStrategy, pickProfile } from "./pool-config.js";
import { getFiveHourRemainingPercent } from "./rate-limits.js";
import { getRateLimitCache } from "./rate-limit-cache.js";
import { getProfileStateManager } from "./profile-state.js";

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
      diagnostics: {
        mode: "explicit",
      },
    };
  }

  const strategy = getConfigStrategy(config);
  // Filter out disabled profiles
  const stateManager = getProfileStateManager();
  const enabledProfiles = stateManager.filterEnabled(config.profiles);
  const disabledProfiles = config.profiles.filter((p) => !enabledProfiles.includes(p));
  
  if (enabledProfiles.length === 0) {
    throw new Error("All profiles are currently disabled due to auth failures. Please wait 30 minutes and try again.");
  }

  // Create a filtered config for selection
  const filteredConfig = { ...config, profiles: enabledProfiles };

  if (strategy !== MAX_REMAINING_5H_SELECTION_STRATEGY || cliContext.appType !== "codex") {
    return {
      profile: pickProfile(filteredConfig),
      diagnostics: {
        mode: RANDOM_SELECTION_STRATEGY,
        disabledProfiles: disabledProfiles.map((p) => p.name),
      },
    };
  }

  if (!allowLiveProbe) {
    return {
      profile: fallbackToRandom(filteredConfig),
      diagnostics: {
        mode: "random-fallback",
        reason: "live_probe_disabled",
        disabledProfiles: disabledProfiles.map((p) => p.name),
      },
    };
  }

  // Use cached rate limits for fast selection
  const cache = getRateLimitCache({ codexCommand: launchCommand });
  
  // Load existing cache first
  if (!cache.cache) {
    await cache.load();
  }

  // Check if cache is stale (> 5 minutes old) and refresh in background if needed
  const cacheAge = cache.cache?.updatedAt ? Date.now() - cache.cache.updatedAt : Infinity;
  const needsRefresh = cacheAge > 5 * 60 * 1000; // 5 minutes

  // Try to get best profile from cache (only from enabled profiles)
  const cachedBest = cache.getProfileWithMostRemaining();
  
  if (cachedBest && !needsRefresh) {
    // Cache is fresh, use it directly if still enabled
    const matchedProfile = filteredConfig.profiles.find((p) => p.name === cachedBest.profileName);
    if (matchedProfile) {
      return {
        profile: matchedProfile,
        diagnostics: {
          mode: MAX_REMAINING_5H_SELECTION_STRATEGY,
          selectedRemaining5hPercent: getFiveHourRemainingPercent(cachedBest.snapshot),
          source: "cache",
          cacheAgeMs: cacheAge,
          disabledProfiles: disabledProfiles.map((p) => p.name),
        },
      };
    }
  }

  // Cache is stale or missing, trigger background refresh but use best available
  if (needsRefresh) {
    // Start background refresh but don't wait
    cache.refreshProfiles(enabledProfiles).catch(() => {});
  }

  // If we have any cached data, use it for selection
  if (cachedBest) {
    const matchedProfile = filteredConfig.profiles.find((p) => p.name === cachedBest.profileName);
    if (matchedProfile) {
      return {
        profile: matchedProfile,
        diagnostics: {
          mode: MAX_REMAINING_5H_SELECTION_STRATEGY,
          selectedRemaining5hPercent: getFiveHourRemainingPercent(cachedBest.snapshot),
          source: "cache-stale",
          cacheAgeMs: cacheAge,
          disabledProfiles: disabledProfiles.map((p) => p.name),
        },
      };
    }
  }

  // No cache available, fall back to random
  return {
    profile: fallbackToRandom(filteredConfig),
    diagnostics: {
      mode: "random-fallback",
      reason: "no-cache",
      disabledProfiles: disabledProfiles.map((p) => p.name),
    },
  };
}

export function startRateLimitCacheRefresh(profiles, options = {}) {
  // Filter out disabled profiles before refresh
  const stateManager = getProfileStateManager();
  const enabledProfiles = stateManager.filterEnabled(profiles);
  
  const cache = getRateLimitCache({
    ...options,
    configDir: options.configDir || process.cwd(),
  });
  
  // Start background refresh cycle (only for enabled profiles)
  cache.startBackgroundRefresh(enabledProfiles);
  
  return cache;
}

export function stopRateLimitCacheRefresh() {
  const cache = getRateLimitCache();
  cache.stopBackgroundRefresh();
}

export function getRateLimitCacheStatus() {
  const cache = getRateLimitCache();
  return cache.getStatus();
}
