import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectNativeTier,
  collectSlowTier,
  mergeTiers,
  resolveCcusageStandalone,
} from "../src/collector.js";
import { watchRoots } from "../src/watch.js";

describe("Codex replay-aware collection", () => {
  it("resolves the installed ccusage dependency during development", () => {
    expect(resolveCcusageStandalone({} as NodeJS.ProcessEnv)).not.toBeNull();
  });

  it("watches live and archived Codex roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "burnbar-codex-watch-"));
    const home = join(root, "codex");
    await Promise.all([
      mkdir(join(home, "sessions"), { recursive: true }),
      mkdir(join(home, "archived_sessions"), { recursive: true }),
    ]);
    const roots = watchRoots({
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: join(root, "empty-claude"),
      HOME: root,
    } as NodeJS.ProcessEnv);
    expect(roots).toContain(join(home, "sessions"));
    expect(roots).toContain(join(home, "archived_sessions"));
  });

  it("uses the bundled replay-aware parser in the fast tier", async () => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), "burnbar-codex-"));
    const bin = join(root, "fake-ccusage");
    const codexHome = join(root, "empty-codex-home");
    const fixture = JSON.stringify({
      daily: [
        {
          date: "2026-08-09",
          totalCost: 0.25,
          modelBreakdowns: [
            {
              modelName: "gpt-5.6-codex",
              inputTokens: 100,
              outputTokens: 20,
              cacheCreationTokens: 0,
              cacheReadTokens: 880,
              cost: 0.25,
            },
          ],
        },
      ],
    });
    await writeFile(
      bin,
      `#!/bin/sh\nif [ "$1" = "codex" ] && [ "$CODEX_HOME" = "${codexHome}" ]; then\n  printf '%s' '${fixture}'\nelse\n  printf '%s' '{}'\nfi\n`,
    );
    await chmod(bin, 0o755);

    const env = {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: join(root, "empty-claude-home"),
      BURNBAR_CCUSAGE: bin,
      BURNBAR_CACHE_DIR: join(root, "cache"),
      WHOBURNEDMORE_PRICING_OFFLINE: "1",
    } as NodeJS.ProcessEnv;
    const tier = await collectNativeTier(env);

    expect(tier.codex.found).toBe(true);
    expect(tier.codexReplayAware).toBe(true);
    expect(tier.codex.entries).toHaveLength(1);
    expect(tier.codex.entries[0].model).toBe("gpt-5.6-codex");
    expect(
      tier.codex.entries[0].inputTokens +
        tier.codex.entries[0].outputTokens +
        tier.codex.entries[0].cacheCreationTokens +
        tier.codex.entries[0].cacheReadTokens,
    ).toBe(1_000);

    const slow = await collectSlowTier(env, { offline: true });
    expect(slow.bySource.get("codex")?.[0]?.model).toBe("gpt-5.6-codex");
    // This parser-only test must never inherit a real Cursor session and wait
    // on cursor.com. The fake ccusage children finish comfortably under 5s.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("does not publish native Codex fallback rows when ccusage fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "burnbar-codex-fail-"));
    const bin = join(root, "failing-ccusage");
    const codexHome = join(root, "codex-home");
    const rolloutDir = join(codexHome, "sessions", "2026", "08", "09");
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(bin, "#!/bin/sh\nexit 1\n");
    await chmod(bin, 0o755);
    await writeFile(
      join(rolloutDir, "rollout-2026-08-09-session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-08-09T12:00:00Z",
          type: "session_meta",
          payload: { model: "gpt-5.6-codex" },
        }),
        JSON.stringify({
          timestamp: "2026-08-09T12:01:00Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            input_tokens: 900,
            cached_input_tokens: 800,
            output_tokens: 100,
          },
        }),
      ].join("\n"),
    );

    const tier = await collectNativeTier({
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: join(root, "empty-claude-home"),
      BURNBAR_CCUSAGE: bin,
      BURNBAR_CACHE_DIR: join(root, "cache"),
    } as NodeJS.ProcessEnv);

    expect(tier.codexReplayAware).toBe(false);
    expect(tier.codex.entries).toEqual([]);
    expect(tier.toolsFound).not.toContain("codex");
  });

  it("reuses the replay-aware Codex result between frequent native safety polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "burnbar-codex-throttle-"));
    const bin = join(root, "counting-ccusage");
    const count = join(root, "calls");
    await writeFile(
      bin,
      `#!/bin/sh\nn=$(cat '${count}' 2>/dev/null || printf '0')\nprintf '%s' $((n + 1)) > '${count}'\nprintf '%s' '{"daily":[]}'\n`,
    );
    await chmod(bin, 0o755);
    const env = {
      CODEX_HOME: join(root, "codex"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      HOME: root,
      BURNBAR_CCUSAGE: bin,
      BURNBAR_CACHE_DIR: join(root, "cache"),
      BURNBAR_CODEX_MIN_INTERVAL_MS: "60000",
    } as NodeJS.ProcessEnv;

    await collectNativeTier(env);
    await collectNativeTier(env);
    expect(await readFile(count, "utf8")).toBe("1");
  });

  it("keeps replay-aware Codex rows when merging with a native fallback", () => {
    const base = {
      date: "2026-08-09",
      tool: "codex",
      model: "gpt-5.6-codex",
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      origin: "cli" as const,
      verified: false,
    };
    const merged = mergeTiers(
      {
        claude: { entries: [], found: false, filesScanned: 0 },
        codex: {
          entries: [{ ...base, inputTokens: 6_700, requestCount: 10 }],
          found: true,
          filesScanned: 1,
        },
        others: [],
        toolsFound: ["codex"],
        partial: false,
        codexReplayAware: false,
      },
      {
        bySource: new Map([["codex", [{ ...base, inputTokens: 1_000 }]]]),
        succeededSources: new Set(["codex"]),
        cursor: [],
        sessions: [],
        toolsFound: ["codex"],
      },
      { preferSlowCodex: true },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].inputTokens).toBe(1_000);
    expect(merged[0].requestCount).toBeUndefined();
  });

  it("keeps a fresh replay-aware fast result over an older slow snapshot", () => {
    const base = {
      date: "2026-08-09",
      tool: "codex",
      model: "gpt-5.6-codex",
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      origin: "cli" as const,
      verified: false,
    };
    const merged = mergeTiers(
      {
        claude: { entries: [], found: false, filesScanned: 0 },
        codex: {
          entries: [{ ...base, inputTokens: 1_200 }],
          found: true,
          filesScanned: 0,
        },
        codexReplayAware: true,
        others: [],
        toolsFound: ["codex"],
        partial: false,
      },
      {
        bySource: new Map([["codex", [{ ...base, inputTokens: 1_000 }]]]),
        succeededSources: new Set(),
        cursor: [],
        sessions: [],
        toolsFound: ["codex"],
      },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].inputTokens).toBe(1_200);
  });

  it("treats a successful empty Codex result as authoritative", () => {
    const base = {
      date: "2026-08-09",
      tool: "codex",
      model: "gpt-5.6-codex",
      inputTokens: 1_200,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      origin: "cli" as const,
      verified: false,
    };
    const merged = mergeTiers(
      {
        claude: { entries: [], found: false, filesScanned: 0 },
        codex: { entries: [base], found: true, filesScanned: 0 },
        codexReplayAware: true,
        others: [],
        toolsFound: ["codex"],
        partial: false,
      },
      {
        bySource: new Map([["codex", []]]),
        succeededSources: new Set(["codex"]),
        cursor: [],
        sessions: [],
        toolsFound: [],
      },
      { preferSlowCodex: true },
    );
    expect(merged).toEqual([]);
  });
});
