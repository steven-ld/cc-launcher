import { MAX_REMAINING_5H_SELECTION_STRATEGY, RANDOM_SELECTION_STRATEGY, getConfigStrategy, pickProfile } from "./pool-config.js";
import { getFiveHourRemainingPercent, readOfficialRateLimits } from "./rate-limits.js";
import { prepareCodexHome } from "./runtime-home.js";

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
  if (strategy !== MAX_REMAINING_5H_SELECTION_STRATEGY || cliContext.appType !== "codex") {
    return {
      profile: pickProfile(config),
      diagnostics: {
        mode: RANDOM_SELECTION_STRATEGY,
      },
    };
  }

  if (!allowLiveProbe) {
    return {
      profile: fallbackToRandom(config),
      diagnostics: {
        mode: "random-fallback",
        reason: "live_probe_disabled",
      },
    };
  }

  const officialCandidates = config.profiles
    .map((profile, index) => ({ profile, index }))
    .filter(({ profile }) => isOfficialCodexProbeCandidate(profile));
  const skippedProfiles = config.profiles.filter((profile) => !isOfficialCodexProbeCandidate(profile));

  if (officialCandidates.length === 0) {
    return {
      profile: fallbackToRandom(config),
      diagnostics: {
        mode: "random-fallback",
        reason: "no_official_candidates",
        skippedProfiles,
      },
    };
  }

  const successfulProbes = [];
  const failedProbes = [];

  for (const candidate of officialCandidates) {
    const runtime = await prepareCodexHome({
      configDir,
      config,
      profile: candidate.profile,
      appType: cliContext.appType,
      writeFiles: true,
    });

    try {
      const result = await readOfficialRateLimits({
        codexCommand: launchCommand,
        env: runtime.env,
        cwd,
      });

      successfulProbes.push({
        ...candidate,
        runtime,
        snapshot: result.snapshot,
        remaining5hPercent: getFiveHourRemainingPercent(result.snapshot),
      });
    } catch (error) {
      failedProbes.push({
        ...candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (successfulProbes.length > 0) {
    successfulProbes.sort(byRemainingDescending);
    return {
      profile: successfulProbes[0].profile,
      diagnostics: {
        mode: MAX_REMAINING_5H_SELECTION_STRATEGY,
        selectedRemaining5hPercent: successfulProbes[0].remaining5hPercent,
        successfulProbes,
        failedProbes,
        skippedProfiles,
      },
    };
  }

  if (skippedProfiles.length > 0) {
    return {
      profile: fallbackToRandom({
        ...config,
        profiles: skippedProfiles,
      }),
      diagnostics: {
        mode: "random-fallback",
        reason: "official_probe_failed",
        failedProbes,
        skippedProfiles,
      },
    };
  }

  const failureSummary = failedProbes
    .map((entry) => `${entry.profile.name}: ${entry.error}`)
    .join(" | ");
  throw new Error(`No official Codex profiles passed live rate-limit probing. ${failureSummary}`);
}
