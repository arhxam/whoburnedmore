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
    process.exitCode = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeSyncFixture(prefix: string, config: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
    const fakeCcusage = join(root, "ccusage");
    writeFileSync(
      fakeCcusage,
      `#!/bin/sh
printf '{"daily":[{"date":"2026-08-10","models":{"gpt-5.6-codex":{"inputTokens":10,"outputTokens":2,"cacheCreationTokens":0,"cacheReadTokens":0}},"totalCost":0}]}'
`,
    );
    chmodSync(fakeCcusage, 0o755);
    return {
      configDir,
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
    };
  }

  async function runSyncCaptured(env: NodeJS.ProcessEnv) {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runSync({ nativeOnly: true, env });
      return { logs, exitCode: process.exitCode };
    } finally {
      process.exitCode = previousExitCode;
    }
  }

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

  it("mints an access token from a stored refresh token before syncing", async () => {
    const refreshToken = "r".repeat(64);
    const { configDir, env } = writeSyncFixture("bb-sync-refresh-only-", {
      handle: "stale",
      anonKey: "machine-secret",
      refreshToken,
    });
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
          JSON.stringify({
            rank: 4,
            totalTokens: 12,
            totalCostUSD: 0,
            profileUrl: "https://example.test/u/burner",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const { logs, exitCode } = await runSyncCaptured(env);

    expect(submits).toBe(1);
    expect(exitCode).toBeUndefined();
    expect(logs.some((line) => line.includes("not-connected"))).toBe(false);
    expect(JSON.parse(logs.at(-1) ?? "")).toMatchObject({
      rank: 4,
      totalTokens: 12,
      profileUrl: "https://example.test/u/burner",
    });
    expect(loadConfig(configDir)).toMatchObject({
      cliToken: "fresh",
      handle: "burner",
      anonKey: "machine-secret",
      refreshToken,
    });
    expect(loadConfig(configDir)?.lastSyncAt).toEqual(expect.any(Number));
  });

  it("reports not-connected when a stored refresh token cannot mint an access token", async () => {
    const stored = {
      handle: "burner",
      anonKey: "machine-secret",
      refreshToken: "r".repeat(64),
    };
    const { configDir, env } = writeSyncFixture("bb-sync-refresh-fail-", stored);
    let refreshes = 0;
    let submits = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/refresh")) {
        refreshes += 1;
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/submit")) {
        submits += 1;
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const { logs, exitCode } = await runSyncCaptured(env);

    expect(refreshes).toBe(1);
    expect(submits).toBe(0);
    expect(exitCode).toBe(3);
    expect(logs).toEqual([JSON.stringify({ error: "not-connected" })]);
    expect(loadConfig(configDir)).toEqual(stored);
  });

  it("clears the stored sign-in when an unauthorized submit cannot be refreshed", async () => {
    const refreshToken = "r".repeat(64);
    const { configDir, env } = writeSyncFixture("bb-sync-unauthorized-", {
      cliToken: "expired",
      handle: "burner",
      anonKey: "machine-secret",
      refreshToken,
      lastSyncAt: 111,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/refresh") || url.endsWith("/v1/submit")) {
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const { logs, exitCode } = await runSyncCaptured(env);

    expect(exitCode).toBe(3);
    expect(logs).toEqual([JSON.stringify({ error: "unauthorized" })]);
    expect(loadConfig(configDir)).toEqual({
      anonKey: "machine-secret",
      refreshToken,
      lastSyncAt: 111,
    });
  });

  it("clears a refreshed token when the retried submit is still unauthorized", async () => {
    const refreshToken = "r".repeat(64);
    const { configDir, env } = writeSyncFixture("bb-sync-retry-unauthorized-", {
      cliToken: "expired",
      handle: "burner",
      anonKey: "machine-secret",
      refreshToken,
      lastSyncAt: 111,
    });
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
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const { logs, exitCode } = await runSyncCaptured(env);

    expect(submits).toBe(2);
    expect(exitCode).toBe(3);
    expect(logs).toEqual([JSON.stringify({ error: "unauthorized" })]);
    expect(loadConfig(configDir)).toEqual({
      anonKey: "machine-secret",
      refreshToken,
      lastSyncAt: 111,
    });
  });

  it("clears a dead access token when there is no refresh token", async () => {
    const { configDir, env } = writeSyncFixture("bb-sync-no-refresh-", {
      cliToken: "expired",
      handle: "burner",
      anonKey: "machine-secret",
    });
    let refreshes = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/cli/refresh")) {
        refreshes += 1;
        return new Response("{}", { status: 200 });
      }
      if (url.endsWith("/v1/submit")) {
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const { logs, exitCode } = await runSyncCaptured(env);

    expect(refreshes).toBe(0);
    expect(exitCode).toBe(3);
    expect(logs).toEqual([JSON.stringify({ error: "unauthorized" })]);
    expect(loadConfig(configDir)).toEqual({ anonKey: "machine-secret" });
  });

  it("keeps the stored sign-in when submit fails for a reason other than unauthorized", async () => {
    const stored = {
      cliToken: "still-good",
      handle: "burner",
      anonKey: "machine-secret",
      refreshToken: "r".repeat(64),
    };
    const { configDir, env } = writeSyncFixture("bb-sync-other-error-", stored);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/submit")) {
        return new Response(JSON.stringify({ error: "overloaded" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const { logs, exitCode } = await runSyncCaptured(env);

    expect(exitCode).toBe(1);
    expect(logs).toEqual([JSON.stringify({ error: "overloaded" })]);
    expect(loadConfig(configDir)).toEqual(stored);
  });
});
