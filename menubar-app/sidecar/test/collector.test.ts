import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectNativeTier,
  collectSlowTier,
  mergeTiers,
  resolveCcusageStandalone,
  terminateCollectorProcesses,
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

  it("uses one ancestor watcher until both Codex transcript roots exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "burnbar-watch-roots-"));
    const home = join(root, "codex");
    await mkdir(join(home, "sessions"), { recursive: true });
    const env = { HOME: root, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude") };
    expect(watchRoots(env).filter((path) => path.startsWith(home))).toEqual([home]);
    await mkdir(join(home, "archived_sessions"));
    expect(watchRoots(env).filter((path) => path.startsWith(home))).toEqual([
      join(home, "sessions"), join(home, "archived_sessions"),
    ]);
  });

  it("keeps unchanged Claude aggregates in memory without rewriting the parse cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "burnbar-claude-idle-"));
    const project = join(root, "claude", "projects", "fixture");
    await mkdir(project, { recursive: true });
    const transcript = join(project, "session.jsonl");
    const fixture = (tokens: number) => JSON.stringify({
      timestamp: new Date().toISOString(), requestId: "request", message: {
        id: "message", model: "claude-sonnet-4-5", usage: {
          input_tokens: tokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        },
      },
    });
    await writeFile(transcript, fixture(100));
    const bin = join(root, "ccusage");
    await writeFile(bin, "#!/bin/sh\nprintf '{\"daily\":[]}'\n");
    await chmod(bin, 0o755);
    const env = {
      HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
      BURNBAR_CACHE_DIR: join(root, "cache"), BURNBAR_CCUSAGE: bin, WHOBURNEDMORE_PRICING_OFFLINE: "1",
    };
    const initial = await collectNativeTier(env);
    const cachePath = join(root, "cache", "native-cache-claude.json");
    const cacheTime = (await stat(cachePath)).mtimeMs;
    const idle = await collectNativeTier(env);
    expect(idle.claude.entries).toEqual(initial.claude.entries);
    expect(idle.claude.filesScanned).toBe(0);
    expect((await stat(cachePath)).mtimeMs).toBe(cacheTime);
    await writeFile(transcript, fixture(200));
    const updated = await collectNativeTier(env);
    expect(updated.claude.filesScanned).toBe(1);
    expect(updated.claude.entries[0]?.inputTokens).toBe(200);
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

  it("terminates in-flight parser children during watch shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "burnbar-codex-shutdown-"));
    const bin = join(root, "blocking-ccusage");
    const pidFile = join(root, "pid");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => process.stdout.write('{"daily":[]}'), 60000);
`,
    );
    await chmod(bin, 0o755);
    const pending = collectNativeTier({
      CODEX_HOME: join(root, "codex"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      HOME: root,
      BURNBAR_CCUSAGE: bin,
      BURNBAR_CACHE_DIR: join(root, "cache"),
      WHOBURNEDMORE_PRICING_OFFLINE: "1",
    } as NodeJS.ProcessEnv);

    let pid: number | null = null;
    for (let attempt = 0; attempt < 40 && pid === null; attempt += 1) {
      try {
        const candidate = Number(await readFile(pidFile, "utf8"));
        // The file can exist before writeFileSync fills it. PID 0 targets our
        // process group, so wait for an actual child ID before asserting exit.
        if (Number.isInteger(candidate) && candidate > 0) pid = candidate;
        else await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(pid).not.toBeNull();
    terminateCollectorProcesses();
    await pending;
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("avoids idle parser launches, shares fast/slow Codex work and caps all parser children at two", async () => {
    const root = await mkdtemp(join(tmpdir(), "burnbar-parser-budget-"));
    const bin = join(root, "counting-ccusage");
    const events = join(root, "events");
    await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const source = process.argv[2];
const events = ${JSON.stringify(events)};
fs.appendFileSync(events, JSON.stringify({ source, delta: 1 }) + "\\n");
setTimeout(() => {
  fs.appendFileSync(events, JSON.stringify({ source, delta: -1 }) + "\\n");
  process.stdout.write('{"daily":[],"sessions":[]}');
}, 50);
`);
    await chmod(bin, 0o755);
    const env = {
      CODEX_HOME: join(root, "codex"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      HOME: root,
      BURNBAR_CCUSAGE: bin,
      BURNBAR_CACHE_DIR: join(root, "cache"),
      BURNBAR_CODEX_MIN_INTERVAL_MS: "0",
      WHOBURNEDMORE_PRICING_OFFLINE: "1",
    } as NodeJS.ProcessEnv;

    await Promise.all([collectNativeTier(env), collectSlowTier(env, { offline: true })]);
    await collectNativeTier(env);
    await collectNativeTier(env);
    const observations = (await readFile(events, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(observations.filter((event) => event.source === "codex" && event.delta === 1)).toHaveLength(1);
    let active = 0;
    let peak = 0;
    for (const event of observations) {
      active += event.delta;
      peak = Math.max(peak, active);
    }
    expect(active).toBe(0);
    expect(peak).toBeLessThanOrEqual(2);

    await mkdir(join(root, "codex", "sessions"), { recursive: true });
    await writeFile(join(root, "codex", "sessions", "rollout.jsonl"), "{}\n");
    await collectNativeTier(env);
    const changed = (await readFile(events, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(changed.filter((event) => event.source === "codex" && event.delta === 1)).toHaveLength(2);
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
