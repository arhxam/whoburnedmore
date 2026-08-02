import { describe, expect, it } from "vitest";
import {
  CODEX_CACHE_VERSION,
  aggregateCodexSessions,
  parseCodexRollout,
  resolveCodexSessionsDir,
  resolveCodexSessionsDirs,
} from "../src/native/codex.js";

const meta = (model: string) =>
  JSON.stringify({ timestamp: "2026-06-10T12:00:00Z", type: "session_meta", payload: { id: "sess-1", model, model_provider: "openai" } });
const turnCtx = (model: string) =>
  JSON.stringify({ timestamp: "2026-06-10T12:00:00Z", type: "turn_context", payload: { type: "turn_context", model } });
/** A cumulative token_count event (inline-fields layout). */
const tokenCount = (ts: string, total: { input: number; cached?: number; output: number; reasoning?: number }) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      input_tokens: total.input,
      cached_input_tokens: total.cached ?? 0,
      output_tokens: total.output,
      reasoning_output_tokens: total.reasoning ?? 0,
      // Real Codex rollouts report reasoning_output_tokens as a BREAKDOWN of
      // output_tokens; total_tokens is input_tokens + output_tokens.
      total_tokens: total.input + total.output,
    },
  });

const total = (e: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }) =>
  e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;

describe("parseCodexRollout — cumulative handling", () => {
  it("uses the LAST cumulative token_count (never the sum of turns)", () => {
    const lines = [
      meta("gpt-5-codex"),
      turnCtx("gpt-5-codex"),
      tokenCount("2026-06-10T12:01:00Z", { input: 100, output: 50 }), // cumulative after turn 1
      tokenCount("2026-06-10T12:02:00Z", { input: 250, output: 120 }), // cumulative after turn 2
      tokenCount("2026-06-10T12:03:00Z", { input: 400, output: 200 }), // cumulative after turn 3 (final)
    ];
    const out = parseCodexRollout(lines);
    // Single calendar day ⇒ one record carrying the final cumulative,
    // input(400) + output(200), not 100+250+400=750.
    expect(out).toHaveLength(1);
    const [s] = out;
    expect(total(s)).toBe(600);
    expect(s.model).toBe("gpt-5-codex");
    expect(s.turnCount).toBe(3);
  });

  it("splits a multi-day session across days by per-day delta (no last-day dump)", () => {
    const lines = [
      meta("gpt-5-codex"),
      tokenCount("2026-06-10T12:00:00Z", { input: 100, output: 50 }), // day1 cumulative 150
      tokenCount("2026-06-11T12:00:00Z", { input: 300, output: 120 }), // day2 cumulative 420
      tokenCount("2026-06-12T12:00:00Z", { input: 1000, output: 400 }), // day3 cumulative 1400
    ];
    const out = parseCodexRollout(lines);
    expect(out).toHaveLength(3);
    const byDate = Object.fromEntries(out.map((s) => [s.date, total(s)]));
    expect(byDate["2026-06-10"]).toBe(150); // 150 - 0
    expect(byDate["2026-06-11"]).toBe(270); // 420 - 150
    expect(byDate["2026-06-12"]).toBe(980); // 1400 - 420
    // Per-day deltas sum back to the final cumulative — no double counting.
    expect(out.reduce((sum, s) => sum + total(s), 0)).toBe(1400);
  });

  it("maps cached input separately without double-counting reasoning output", () => {
    const lines = [
      meta("gpt-5-codex"),
      tokenCount("2026-06-10T12:05:00Z", { input: 1000, cached: 600, output: 200, reasoning: 80 }),
    ];
    const [s] = parseCodexRollout(lines);
    expect(s.cacheReadTokens).toBe(600);
    expect(s.inputTokens).toBe(400); // 1000 - 600 cached
    expect(s.outputTokens).toBe(200); // reasoning is already included in output
    expect(s.cacheCreationTokens).toBe(0);
  });

  it("invalidates caches created before reasoning output was de-duplicated", () => {
    expect(CODEX_CACHE_VERSION).toBe(2);
  });

  it("reads the nested info.total_token_usage layout", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-10T12:06:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 90 } },
      },
    });
    const [s] = parseCodexRollout([meta("gpt-5"), line]);
    expect(s.inputTokens).toBe(200);
    expect(s.cacheReadTokens).toBe(100);
    expect(s.outputTokens).toBe(90);
  });

  it("returns an empty array for a session with no token_count events", () => {
    expect(parseCodexRollout([meta("gpt-5"), turnCtx("gpt-5")])).toEqual([]);
  });

  it("does not emit a poisonous day when the first timestamp is out of range", () => {
    expect(
      parseCodexRollout([
        meta("gpt-5"),
        tokenCount("2099-01-01T00:00:00Z", { input: 100, output: 50 }),
      ]),
    ).toEqual([]);
  });
});

describe("aggregateCodexSessions", () => {
  it("sums sessions into per-date+model buckets and accumulates turn counts", () => {
    const sessionA = [meta("gpt-5-codex"), tokenCount("2026-06-10T12:01:00Z", { input: 100, output: 50 })];
    const sessionB = [meta("gpt-5-codex"), tokenCount("2026-06-10T13:01:00Z", { input: 300, output: 50 }), tokenCount("2026-06-10T13:05:00Z", { input: 400, output: 80 })];
    const entries = aggregateCodexSessions([sessionA, sessionB]);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.tool).toBe("codex");
    // session A final 150 + session B final 480 = 630
    expect(total(e)).toBe(630);
    expect(e.requestCount).toBe(3); // 1 + 2 turn events
    expect(e.origin).toBe("cli");
    expect(e.verified).toBe(false);
  });

  it("separates different models and dates", () => {
    const a = [meta("gpt-5-codex"), tokenCount("2026-06-10T12:00:00Z", { input: 10, output: 5 })];
    const b = [meta("gpt-4o"), tokenCount("2026-06-10T12:00:00Z", { input: 20, output: 5 })];
    const c = [meta("gpt-5-codex"), tokenCount("2026-06-20T12:00:00Z", { input: 30, output: 5 })];
    const entries = aggregateCodexSessions([a, b, c]);
    expect(entries).toHaveLength(3);
  });
});

describe("resolveCodexSessionsDir", () => {
  it("defaults to ~/.codex/sessions and honors CODEX_HOME", () => {
    expect(resolveCodexSessionsDir({} as NodeJS.ProcessEnv)).toMatch(/\.codex\/sessions$/);
    expect(resolveCodexSessionsDir({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv)).toBe("/custom/codex/sessions");
  });
});

describe("resolveCodexSessionsDirs", () => {
  it("covers both the live and the archived rollout roots", () => {
    expect(resolveCodexSessionsDirs({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv)).toEqual([
      "/custom/codex/sessions",
      "/custom/codex/archived_sessions",
    ]);
  });

  it("defaults to ~/.codex and keeps the live dir first", () => {
    const dirs = resolveCodexSessionsDirs({} as NodeJS.ProcessEnv);
    expect(dirs[0]).toMatch(/\.codex\/sessions$/);
    expect(dirs[1]).toMatch(/\.codex\/archived_sessions$/);
  });
});
