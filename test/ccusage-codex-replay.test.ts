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
