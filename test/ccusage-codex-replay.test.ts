import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  mapCcusageDaily,
  mapCcusageSessions,
  resolveCcusageBin,
} from "../src/collect.js";

const execFileAsync = promisify(execFile);

const parentId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";

function meta(id: string, timestamp: string, forkedFrom?: string): string {
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      timestamp,
      model_provider: "openai",
      ...(forkedFrom
        ? {
            forked_from_id: forkedFrom,
            parent_thread_id: forkedFrom,
            source: { subagent: { thread_spawn: { parent_thread_id: forkedFrom } } },
          }
        : {}),
    },
  });
}

function turn(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { model: "gpt-5-codex" },
  });
}

function tokens(
  timestamp: string,
  cumulative: { input: number; cached: number; output: number },
  last: { input: number; cached: number; output: number },
): string {
  const usage = (u: typeof cumulative) => ({
    input_tokens: u.input,
    cached_input_tokens: u.cached,
    output_tokens: u.output,
    reasoning_output_tokens: 0,
    total_tokens: u.input + u.output,
  });
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(cumulative),
        last_token_usage: usage(last),
        model_context_window: 200_000,
      },
    },
  });
}

describe("bundled ccusage Codex replay handling", () => {
  it("counts a forked parent prefix once and only adds the child's advancement", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-ccusage-replay-"));
    const sessions = join(root, "sessions", "2026", "08", "09");
    await mkdir(sessions, { recursive: true });

    const parent = [
      meta(parentId, "2026-08-09T10:00:00.000Z"),
      turn("2026-08-09T10:00:00.100Z"),
      tokens(
        "2026-08-09T10:00:01.000Z",
        { input: 100, cached: 80, output: 10 },
        { input: 100, cached: 80, output: 10 },
      ),
      tokens(
        "2026-08-09T10:00:02.000Z",
        { input: 200, cached: 160, output: 20 },
        { input: 100, cached: 80, output: 10 },
      ),
    ].join("\n");
    const child = [
      meta(childId, "2026-08-09T10:00:03.000Z", parentId),
      turn("2026-08-09T10:00:03.100Z"),
      // Replayed prefix deliberately spans >1 second so correctness depends on
      // parent-prefix matching rather than the old dense-burst heuristic.
      tokens(
        "2026-08-09T10:00:04.000Z",
        { input: 100, cached: 80, output: 10 },
        { input: 100, cached: 80, output: 10 },
      ),
      tokens(
        "2026-08-09T10:00:06.000Z",
        { input: 200, cached: 160, output: 20 },
        { input: 100, cached: 80, output: 10 },
      ),
      tokens(
        "2026-08-09T10:00:08.000Z",
        { input: 300, cached: 240, output: 30 },
        { input: 100, cached: 80, output: 10 },
      ),
    ].join("\n");
    await Promise.all([
      writeFile(join(sessions, `rollout-parent-${parentId}.jsonl`), parent),
      writeFile(join(sessions, `rollout-child-${childId}.jsonl`), child),
    ]);

    const { cmd, prefixArgs } = resolveCcusageBin();
    const { stdout } = await execFileAsync(
      cmd,
      [...prefixArgs, "codex", "daily", "--json", "--offline"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CODEX_HOME: root },
      },
    );
    const entries = mapCcusageDaily("codex", JSON.parse(stdout));
    const total = entries.reduce(
      (sum, e) =>
        sum +
        e.inputTokens +
        e.outputTokens +
        e.cacheCreationTokens +
        e.cacheReadTokens,
      0,
    );

    // Parent = 220. Child replay = 220 (must be skipped). Child advancement = 110.
    expect(total).toBe(330);

    const { stdout: sessionStdout } = await execFileAsync(
      cmd,
      [...prefixArgs, "session", "--json", "--offline"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CODEX_HOME: root },
      },
    );
    const sessionTotal = mapCcusageSessions(JSON.parse(sessionStdout))
      .filter((session) => session.tool === "codex")
      .reduce(
        (sum, session) =>
          sum +
          session.inputTokens +
          session.outputTokens +
          session.cacheCreationTokens +
          session.cacheReadTokens,
        0,
      );
    expect(sessionTotal).toBe(330);
  }, 30_000);
});

// OpenCode v2.1 moved usage into `session_message` + `session_v2`. ccusage
// 20.0.19 read only the legacy `message` table and silently reported zero
// (public issue #24). node:sqlite builds the synthetic database where it exists
// (Node >= 22.5); older runtimes skip this one integration check.
type SqliteDatabase = { exec(sql: string): void; close(): void };
async function openSqlite(path: string): Promise<SqliteDatabase | null> {
  try {
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (p: string) => SqliteDatabase;
    };
    return new mod.DatabaseSync(path);
  } catch {
    return null;
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

describe("bundled ccusage OpenCode v2 schema", () => {
  it("reads session_message usage and counts a fork's copied history once", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-ccusage-opencode-"));
    const dataDir = join(root, "opencode");
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(root, "xdg"), { recursive: true });
    const db = await openSqlite(join(dataDir, "opencode.db"));
    if (!db) return;
    const created = Date.parse("2026-08-09T10:00:00.000Z");
    const payload = (input: number, output: number, cost: number) =>
      JSON.stringify({
        model: { id: "gpt-test", providerID: "openai" },
        time: { created },
        tokens: { input, output },
        cost,
      });
    const rows: Array<[string, string, number, number, number, number]> = [
      ["parent-1", "parent", 0, 100, 10, 0.01],
      ["parent-2", "parent", 1, 200, 10, 0.01],
      ["boundary", "parent", 2, 300, 10, 0.01],
      ["parent-4", "parent", 3, 400, 10, 0.01],
      ["fork-copy-1", "fork", 0, 100, 10, 0.01],
      ["fork-copy-2", "fork", 1, 200, 10, 0.01],
      ["fork-copy-boundary", "fork", 2, 300, 10, 0.01],
      ["fork-own", "fork", 4, 40, 4, 0.02],
    ];
    db.exec(`
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
  seq INTEGER NOT NULL DEFAULT 0, time_created INTEGER, data TEXT);
CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER, cost REAL,
  tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER,
  tokens_cache_write INTEGER, tokens_reasoning INTEGER, model TEXT,
  fork_session_id TEXT, fork_boundary TEXT);
${rows
  .map(
    ([id, session, seq, input, output, cost]) =>
      `INSERT INTO session_message VALUES (${sqlString(id)}, ${sqlString(session)}, 'assistant', ${seq}, ${created + seq}, ${sqlString(payload(input, output, cost))});`,
  )
  .join("\n")}
INSERT INTO session_v2 (id, fork_session_id, fork_boundary) VALUES ('fork', 'parent', ${sqlString(JSON.stringify({ type: "through", messageID: "boundary" }))});
`);
    db.close();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, "xdg"),
      XDG_DATA_HOME: join(root, "xdg"),
      TZ: "UTC",
      OPENCODE_DATA_DIR: dataDir,
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    const { cmd, prefixArgs } = resolveCcusageBin();
    const { stdout } = await execFileAsync(
      cmd,
      [...prefixArgs, "opencode", "daily", "--json", "--offline"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env },
    );
    const entries = mapCcusageDaily("opencode", JSON.parse(stdout));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      date: "2026-08-09",
      tool: "opencode",
      model: "gpt-test",
      // Parent turns contribute 1000 input; the fork adds only its own 40.
      inputTokens: 1040,
      outputTokens: 44,
    });
    expect(entries[0].costUSD).toBeCloseTo(0.06, 6);
  }, 30_000);
});

function isolatedEnv(root: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_DATA_HOME: join(root, "xdg"),
    TZ: "UTC",
    ...extra,
  };
  for (const key of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
    "ZCODE_HOME",
    "ANTIGRAVITY_DATA_DIR",
  ]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

async function ccusageDaily(source: string, env: NodeJS.ProcessEnv) {
  const { cmd, prefixArgs } = resolveCcusageBin();
  const { stdout } = await execFileAsync(
    cmd,
    [...prefixArgs, source, "daily", "--json", "--offline"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env },
  );
  return mapCcusageDaily(source, JSON.parse(stdout));
}

// Sources added in 0.9.25 (public issues #16 and #25, PR #27). Each is read by
// the bundled ccusage; these pin the on-disk shapes we rely on it to parse.
describe("bundled ccusage Grok, ZCode and Antigravity sources", () => {
  it("reads completed Grok Build turns and keeps the recorded invoice cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-ccusage-grok-"));
    const session = join(root, ".grok", "sessions", "%2Fwork%2Fapp", "sess-1");
    await mkdir(session, { recursive: true });
    await mkdir(join(root, "xdg"), { recursive: true });
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cachedReadTokens: 40,
      reasoningTokens: 10,
      totalTokens: 120,
    };
    const line = (event: string, state: string, ticks?: number) =>
      JSON.stringify({
        timestamp: Math.floor(Date.parse("2026-08-09T10:00:00.000Z") / 1000),
        method: "_x.ai/session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: state,
            usage: {
              ...usage,
              modelUsage: {
                "grok-4.5-build": {
                  ...usage,
                  ...(ticks === undefined ? {} : { costUsdTicks: ticks }),
                },
              },
            },
          },
          _meta: { eventId: event },
        },
      });
    await writeFile(
      join(session, "updates.jsonl"),
      // An in-progress turn is ignored until it completes.
      [line("evt-0", "turn_started"), line("evt-1", "turn_completed", 5_000_000_000)].join("\n") + "\n",
    );
    const entries = await ccusageDaily("grok", isolatedEnv(root, {}));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      date: "2026-08-09",
      tool: "grok",
      model: "grok-4.5-build",
      // OpenAI-style input includes cache reads; ccusage splits them out.
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 20,
    });
    // 5e9 ticks of 1e-10 USD = $0.50, exactly what Grok recorded.
    expect(entries[0].costUSD).toBeCloseTo(0.5, 6);
  }, 30_000);

  it("reads completed ZCode model_usage rows and splits cache from fresh input", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-ccusage-zcode-"));
    const dbDir = join(root, ".zcode", "cli", "db");
    await mkdir(dbDir, { recursive: true });
    await mkdir(join(root, "xdg"), { recursive: true });
    const db = await openSqlite(join(dbDir, "db.sqlite"));
    if (!db) return;
    const at = Date.parse("2026-08-09T10:00:00.000Z");
    db.exec(`
CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER,
  model_id TEXT, provider_id TEXT, status TEXT, input_tokens INTEGER,
  output_tokens INTEGER, cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER, computed_total_tokens INTEGER);
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, version TEXT);
INSERT INTO session VALUES ('s1', '/work/app', '0.16.3');
INSERT INTO model_usage VALUES ('u1', 's1', ${at}, 'GLM-5.2', 'builtin:zai-coding-plan', 'completed', 100, 10, 15, 25, 110);
INSERT INTO model_usage VALUES ('u2', 's1', ${at + 1000}, 'GLM-5.2', 'builtin:zai-coding-plan', 'failed', 9999, 9999, 0, 0, 19998);
`);
    db.close();
    const entries = await ccusageDaily("zcode", isolatedEnv(root, {}));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      date: "2026-08-09",
      tool: "zcode",
      // input_tokens (100) includes both cache buckets: 100 - 15 - 25 = 60.
      inputTokens: 60,
      cacheCreationTokens: 15,
      cacheReadTokens: 25,
      outputTokens: 10,
    });
  }, 30_000);

  it("exposes an antigravity source that reports nothing for an empty home", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-ccusage-antigravity-"));
    await mkdir(join(root, "xdg"), { recursive: true });
    await expect(ccusageDaily("antigravity", isolatedEnv(root, {}))).resolves.toEqual([]);
  }, 30_000);
});
