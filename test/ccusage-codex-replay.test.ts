import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function isolatedHome(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_DATA_HOME: join(root, "xdg"),
    TZ: "UTC",
  };
  // A set-but-invalid config dir makes ccusage abort. Leave these unset so the
  // temp HOME is the only place it looks, then set the one directory under test.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.OPENCODE_DATA_DIR;
  delete env.CODEX_HOME;
  return env;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function writeOpenCodeV2Database(dbPath: string): Promise<void> {
  const payload = (input: number, output: number, cost: number) =>
    JSON.stringify({
      model: { id: "gpt-test", providerID: "openai" },
      time: { created: 1767312000000 },
      tokens: { input, output },
      cost,
    });
  const rows: Array<[string, string, number, number, number, number]> = [
    ["parent-msg-1", "parent", 0, 100, 10, 0.01],
    ["parent-msg-2", "parent", 1, 200, 10, 0.01],
    ["boundary-msg", "parent", 2, 300, 10, 0.01],
    ["parent-msg-4", "parent", 3, 400, 10, 0.01],
    ["fork-copy-1", "fork", 0, 100, 10, 0.01],
    ["fork-copy-2", "fork", 1, 200, 10, 0.01],
    ["fork-copy-boundary", "fork", 2, 300, 10, 0.01],
    ["fork-own", "fork", 4, 40, 4, 0.02],
  ];
  const inserts = rows
    .map(
      ([id, sessionId, seq, input, output, cost]) =>
        `INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (${sqlString(id)}, ${sqlString(sessionId)}, 'assistant', ${seq}, ${1767312000000 + seq}, ${sqlString(payload(input, output, cost))});`,
    )
    .join("\n");
  const boundary = JSON.stringify({ type: "through", messageID: "boundary-msg" });
  const script = `
CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  type TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER,
  data TEXT
);
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY,
  time_created INTEGER,
  cost REAL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  tokens_reasoning INTEGER,
  model TEXT,
  fork_session_id TEXT,
  fork_boundary TEXT
);
${inserts}
INSERT INTO session_v2 (id, fork_session_id, fork_boundary) VALUES ('fork', 'parent', ${sqlString(boundary)});
`;
  await execFileAsync("sqlite3", [dbPath, script], { encoding: "utf8" });
}

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
    await mkdir(join(root, "xdg"), { recursive: true });

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
    const env = {
      ...isolatedHome(root),
      CODEX_HOME: root,
    };
    const { stdout } = await execFileAsync(
      cmd,
      [...prefixArgs, "codex", "daily", "--json", "--offline"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env,
      },
    );
    const entries = mapCcusageDaily("codex", JSON.parse(stdout));
    const fixtureEntries = mapCcusageDaily(
      "codex",
      loadFixture("ccusage-20.0.48-codex-daily.json"),
    );
    expect(entries).toEqual(fixtureEntries);
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
        env,
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

  it("counts an OpenCode v2 fork once and matches the checked-in daily fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-ccusage-opencode-"));
    const dataDir = join(root, "opencode");
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(root, "xdg"), { recursive: true });
    await writeOpenCodeV2Database(join(dataDir, "opencode.db"));

    const { cmd, prefixArgs } = resolveCcusageBin();
    const { stdout } = await execFileAsync(
      cmd,
      [...prefixArgs, "opencode", "daily", "--json", "--offline"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...isolatedHome(root),
          OPENCODE_DATA_DIR: dataDir,
        },
      },
    );
    const entries = mapCcusageDaily("opencode", JSON.parse(stdout));
    const fixtureEntries = mapCcusageDaily(
      "opencode",
      loadFixture("ccusage-20.0.48-opencode-daily.json"),
    );
    expect(entries).toEqual(fixtureEntries);
    // Parent turns contribute 1000 input. The fork's own turn contributes 40.
    expect(entries[0].inputTokens).toBe(1040);
    expect(entries[0].outputTokens).toBe(44);
    expect(entries[0].costUSD).toBe(0.06);
    expect(
      entries.reduce(
        (sum, entry) =>
          sum +
          entry.inputTokens +
          entry.outputTokens +
          entry.cacheCreationTokens +
          entry.cacheReadTokens,
        0,
      ),
    ).toBe(1084);
  }, 30_000);
});
