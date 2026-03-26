import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  formatUsageReport,
  normalizeRateLimitSnapshot,
  readCachedRateLimits,
  readOfficialRateLimits,
} from "../src/rate-limits.js";

function createSnapshot(overrides = {}) {
  return {
    limit_id: "codex",
    limit_name: null,
    primary: {
      used_percent: 12,
      window_minutes: 300,
      resets_at: 1774375500,
    },
    secondary: {
      used_percent: 34,
      window_minutes: 10080,
      resets_at: 1774528615,
    },
    credits: null,
    plan_type: "team",
    ...overrides,
  };
}

test("normalizeRateLimitSnapshot supports live response envelopes", () => {
  const snapshot = createSnapshot();

  assert.deepEqual(
    normalizeRateLimitSnapshot({
      rateLimits: snapshot,
    }),
    snapshot,
  );

  assert.deepEqual(
    normalizeRateLimitSnapshot({
      rateLimitsByLimitId: {
        codex: snapshot,
      },
    }),
    snapshot,
  );
});

test("formatUsageReport maps official windows to 5h and 1w", () => {
  const report = formatUsageReport({
    profileName: "team-a",
    source: "official-live",
    snapshot: createSnapshot(),
  });

  assert.match(report, /profile: team-a/);
  assert.match(report, /source: official-live/);
  assert.match(report, /5h: 12% used/);
  assert.match(report, /1w: 34% used/);
});

test("readCachedRateLimits reads the latest official snapshot from archived sessions", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-"));
  const archivedSessionsDir = path.join(tempRoot, "archived_sessions");
  await fs.mkdir(archivedSessionsDir, { recursive: true });

  const filePath = path.join(
    archivedSessionsDir,
    "rollout-2026-03-26T16-00-00-019d0000-0000-7000-0000-000000000001.jsonl",
  );
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-03-26T08:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: createSnapshot(),
      },
    })}\n`,
    "utf8",
  );

  const result = await readCachedRateLimits({ codexHome: tempRoot });

  assert.equal(result.filePath, filePath);
  assert.equal(result.timestamp, "2026-03-26T08:00:00.000Z");
  assert.equal(result.snapshot.primary.window_minutes, 300);
  assert.equal(result.snapshot.secondary.window_minutes, 10080);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("readOfficialRateLimits performs initialize, initialized, and account/rateLimits/read", async () => {
  const writes = [];

  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      child.emit("exit", 0, null);
    };

    child.stdin.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (!text) {
        return;
      }

      for (const line of text.split("\n")) {
        const parsed = JSON.parse(line);
        writes.push(parsed);

        if (parsed.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: parsed.id, result: { userAgent: "fake/0.1" } })}\n`);
        }

        if (parsed.method === "account/rateLimits/read") {
          child.stdout.write(
            `${JSON.stringify({
              id: parsed.id,
              result: {
                rateLimits: createSnapshot(),
                rateLimitsByLimitId: {
                  codex: createSnapshot(),
                },
              },
            })}\n`,
          );
        }
      }
    });

    return child;
  };

  const result = await readOfficialRateLimits({
    codexCommand: "fake-codex",
    spawnProcess,
    timeoutMs: 2000,
  });

  assert.equal(result.snapshot.primary.used_percent, 12);
  assert.equal(writes[0].method, "initialize");
  assert.equal(writes[1].method, "initialized");
  assert.equal(writes[2].method, "account/rateLimits/read");
});
