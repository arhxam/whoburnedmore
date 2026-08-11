import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../../src/config.js";
import { buildSyncPayload, runSync } from "../src/sync.js";

describe("live leaderboard sync", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists refreshed auth and last-sync time in the overridden config directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-sync-config-"));
    roots.push(root);
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ cliToken: "expired", anonKey: "machine-secret", refreshToken: "r".repeat(64) }),
    );
    const fakeCcusage = join(root, "ccusage");
    writeFileSync(
      fakeCcusage,
      `#!/bin/sh
printf '{"daily":[{"date":"2026-08-10","models":{"gpt-5.6-codex":{"inputTokens":10,"outputTokens":2,"cacheCreationTokens":0,"cacheReadTokens":0}},"totalCost":0}]}'
`,
    );
    chmodSync(fakeCcusage, 0o755);
    let submits = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/refresh")) {
        return new Response(JSON.stringify({ token: "fresh", handle: "burner" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/submit")) {
        submits += 1;
        return new Response(
          JSON.stringify(
            submits === 1
              ? { error: "expired" }
              : {
                  rank: 1,
                  totalTokens: 12,
                  totalCostUSD: 0,
                  profileUrl: "https://example.test/u/burner",
                },
          ),
          {
            status: submits === 1 ? 401 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runSync({
      nativeOnly: true,
      env: {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CODEX_HOME: join(root, "codex"),
        BURNBAR_CACHE_DIR: join(root, "cache"),
        BURNBAR_CCUSAGE: fakeCcusage,
        BURNBAR_CODEX_MIN_INTERVAL_MS: "0",
        WHOBURNEDMORE_CONFIG_DIR: configDir,
      },
    });

    expect(submits).toBe(2);
    expect(loadConfig(configDir)).toMatchObject({
      cliToken: "fresh",
      handle: "burner",
      anonKey: "machine-secret",
      refreshToken: "r".repeat(64),
    });
    expect(loadConfig(configDir)?.lastSyncAt).toEqual(expect.any(Number));
  });

  it("runs only the replay-aware Codex read, not the expensive all-source collector", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-live-sync-"));
    roots.push(root);
    const marker = join(root, "slow-tier-ran");
    const fakeCcusage = join(root, "ccusage");
    writeFileSync(
      fakeCcusage,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${marker}"\nprintf '{"daily":[],"sessions":[]}\\n'\n`,
    );
    chmodSync(fakeCcusage, 0o755);

    await buildSyncPayload(
      {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CODEX_HOME: join(root, "codex"),
        BURNBAR_CACHE_DIR: join(root, "cache"),
        BURNBAR_CCUSAGE: fakeCcusage,
      },
      { nativeOnly: true },
    );

    expect(readFileSync(marker, "utf8").trim()).toBe(
      "codex daily --json --offline",
    );
  });

  it("attaches exact legacy proof and a targeted tombstone after a successful replay-aware read", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-live-proof-"));
    roots.push(root);
    const fakeCcusage = join(root, "ccusage");
    writeFileSync(fakeCcusage, "#!/bin/sh\nprintf '{\"daily\":[]}'\n");
    chmodSync(fakeCcusage, 0o755);
    const rolloutDir = join(root, "codex", "sessions", "2026", "08", "09");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, "rollout-fork.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-08-09T12:00:00Z",
          type: "session_meta",
          payload: {
            id: "child",
            model: "gpt-5.6-codex",
            forked_from_id: "parent",
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-09T12:01:00Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            input_tokens: 1_000,
            cached_input_tokens: 600,
            output_tokens: 200,
          },
        }),
      ].join("\n"),
    );
    const configDir = join(root, "wbm-config");
    const anonKey = "burnbar-proof-device-secret";
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ anonKey }));

    const payload = await buildSyncPayload(
      {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CODEX_HOME: join(root, "codex"),
        BURNBAR_CACHE_DIR: join(root, "cache"),
        BURNBAR_CCUSAGE: fakeCcusage,
        BURNBAR_CODEX_MIN_INTERVAL_MS: "0",
        WHOBURNEDMORE_CONFIG_DIR: configDir,
      },
      { nativeOnly: true },
    );

    expect(payload.codexReplayTombstoneDates).toEqual(["2026-08-09"]);
    expect(payload.deviceKeyHash).toBe(
      createHash("sha256").update(anonKey).digest("hex"),
    );
    expect(payload.codexReplayPriorScopes).toEqual([
      {
        date: "2026-08-09",
        rows: [
          {
            model: "gpt-5.6-codex",
            inputTokens: 400,
            outputTokens: 200,
            cacheCreationTokens: 0,
            cacheReadTokens: 600,
          },
        ],
      },
    ]);
  });

  it("fails closed without proof or tombstones when the replay-aware read fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-live-proof-fail-"));
    roots.push(root);
    const fakeCcusage = join(root, "ccusage");
    writeFileSync(fakeCcusage, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeCcusage, 0o755);
    const rolloutDir = join(root, "codex", "sessions", "2026", "08", "09");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, "rollout-fork.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-08-09T12:00:00Z",
          type: "session_meta",
          payload: { model: "gpt-5.6-codex", forked_from_id: "parent" },
        }),
        JSON.stringify({
          timestamp: "2026-08-09T12:01:00Z",
          type: "event_msg",
          payload: { type: "token_count", input_tokens: 100, output_tokens: 10 },
        }),
      ].join("\n"),
    );

    const payload = await buildSyncPayload(
      {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CODEX_HOME: join(root, "codex"),
        BURNBAR_CACHE_DIR: join(root, "cache"),
        BURNBAR_CCUSAGE: fakeCcusage,
        BURNBAR_CODEX_MIN_INTERVAL_MS: "0",
      },
      { nativeOnly: true },
    );

    expect(payload.codexReplayTombstoneDates).toBeUndefined();
    expect(payload.codexReplayPriorScopes).toBeUndefined();
  });
});
