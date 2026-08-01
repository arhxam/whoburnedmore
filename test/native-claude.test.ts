import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import {
  CLAUDE_CACHE_VERSION,
  accumulateClaudeLines,
  aggregateClaudeLines,
  collectClaudeNative,
  finalizeClaudeEntries,
  parseClaudeLine,
  resolveClaudeProjectDirs,
  type ClaudeAccumulator,
} from "../src/native/claude.js";

/** Build one Claude Code transcript JSONL line. */
function assistantLine(opts: {
  ts: string;
  model: string;
  reqId?: string;
  msgId?: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  isSidechain?: boolean;
  role?: string;
}): string {
  const message: Record<string, unknown> = {
    role: opts.role ?? "assistant",
    model: opts.model,
    usage: {
      input_tokens: opts.input ?? 0,
      output_tokens: opts.output ?? 0,
      cache_creation_input_tokens: opts.cacheCreate ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
    },
  };
  if (opts.msgId !== undefined) message.id = opts.msgId;
  const obj: Record<string, unknown> = {
    type: "assistant",
    isSidechain: opts.isSidechain ?? false,
    timestamp: opts.ts,
    message,
  };
  if (opts.reqId !== undefined) obj.requestId = opts.reqId;
  return JSON.stringify(obj);
}

const total = (e: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}) =>
  e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;

describe("aggregateClaudeLines — dedup", () => {
  it("dedups streamed lines sharing (message.id, requestId), keeping the maximal-token entry (not keep-first undercount, not sum overcount)", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const lines = [
      // Intermediate streamed line: placeholder token counts.
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_A",
        msgId: "msg_A",
        input: 5,
        output: 1,
      }),
      // Final line for the SAME request: the real totals.
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_A",
        msgId: "msg_A",
        input: 100,
        output: 1093,
        cacheRead: 500,
      }),
    ];
    const entries = aggregateClaudeLines(lines);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    // Kept the maximal entry: 100 + 1093 + 500 = 1693. Not 6 (keep-first), not 1699 (sum).
    expect(total(e)).toBe(1693);
    expect(e.outputTokens).toBe(1093);
    expect(e.requestCount).toBe(1);
  });

  it("counts subagent sidechain usage (real tokens, must not be dropped)", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const lines = [
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_main",
        msgId: "msg_main",
        input: 1000,
      }),
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_sub",
        msgId: "msg_sub",
        input: 2000,
        isSidechain: true,
      }),
    ];
    const [e] = aggregateClaudeLines(lines);
    expect(total(e)).toBe(3000);
    expect(e.requestCount).toBe(2);
  });
});

describe("aggregateClaudeLines — fingerprint", () => {
  it("requestCount equals the number of DISTINCT real provider requests in the bucket", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const lines = [
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_1",
        msgId: "msg_1",
        output: 10,
      }),
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_2",
        msgId: "msg_2",
        output: 20,
      }),
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_3",
        msgId: "msg_3",
        output: 30,
      }),
      // duplicate of req_2 — must not inflate the count
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "req_2",
        msgId: "msg_2",
        output: 5,
      }),
    ];
    const [e] = aggregateClaudeLines(lines);
    expect(e.requestCount).toBe(3);
    expect(e.outputTokens).toBe(60);
  });

  it("counts usage with no provider ids but does NOT credit it to the fingerprint", () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const lines = [
      assistantLine({ ts, model: "claude-opus-4-8", output: 42 }), // no msgId/reqId
    ];
    const [e] = aggregateClaudeLines(lines);
    expect(e.outputTokens).toBe(42);
    expect(e.requestCount).toBe(0);
  });
});

describe("aggregateClaudeLines — grouping & filtering", () => {
  it("groups by date and model into separate entries", () => {
    const lines = [
      assistantLine({
        ts: "2026-06-01T12:00:00Z",
        model: "claude-opus-4-8",
        reqId: "r1",
        msgId: "m1",
        output: 10,
      }),
      assistantLine({
        ts: "2026-06-01T12:00:00Z",
        model: "claude-haiku-4-5",
        reqId: "r2",
        msgId: "m2",
        output: 20,
      }),
      assistantLine({
        ts: "2026-06-10T12:00:00Z",
        model: "claude-opus-4-8",
        reqId: "r3",
        msgId: "m3",
        output: 30,
      }),
    ];
    const entries = aggregateClaudeLines(lines);
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.date)).size).toBe(2);
    expect(new Set(entries.map((e) => e.model)).size).toBe(2);
    expect(entries.every((e) => e.tool === "claude")).toBe(true);
    expect(
      entries.every((e) => e.origin === "cli" && e.verified === false),
    ).toBe(true);
  });

  it("ignores user / usage-less / unparseable lines", () => {
    const ts = "2026-06-10T12:00:00Z";
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
        timestamp: ts,
      }),
      JSON.stringify({ type: "summary", summary: "x", timestamp: ts }),
      "not json at all",
      "",
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "r1",
        msgId: "m1",
        output: 7,
      }),
    ];
    const entries = aggregateClaudeLines(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0].outputTokens).toBe(7);
  });

  it("estimates cost from the model (opus priced, unknown model → 0)", () => {
    const ts = "2026-06-10T12:00:00Z";
    const opus = aggregateClaudeLines([
      assistantLine({
        ts,
        model: "claude-opus-4-8",
        reqId: "r1",
        msgId: "m1",
        output: 1_000_000,
      }),
    ]);
    expect(opus[0].costUSD).toBeGreaterThan(0);
    const unknown = aggregateClaudeLines([
      assistantLine({
        ts,
        model: "some-unlisted-model",
        reqId: "r2",
        msgId: "m2",
        output: 1_000_000,
      }),
    ]);
    expect(unknown[0].costUSD).toBe(0);
  });
});

describe("parseClaudeLine", () => {
  it("returns null for non-assistant and usage-less lines", () => {
    expect(parseClaudeLine("")).toBeNull();
    expect(parseClaudeLine("garbage")).toBeNull();
    expect(
      parseClaudeLine(
        JSON.stringify({
          message: { role: "user" },
          timestamp: "2026-06-10T12:00:00Z",
        }),
      ),
    ).toBeNull();
  });

  it("rejects timestamps that would make the server reject the whole payload", () => {
    expect(
      parseClaudeLine(
        assistantLine({
          ts: "1970-01-01T00:00:00Z",
          model: "claude-opus-4-8",
          output: 1,
        }),
      ),
    ).toBeNull();
    expect(
      parseClaudeLine(
        assistantLine({
          ts: "2099-01-01T00:00:00Z",
          model: "claude-opus-4-8",
          output: 1,
        }),
      ),
    ).toBeNull();
  });

  it("invalidates caches created before timestamp hardening", () => {
    expect(CLAUDE_CACHE_VERSION).toBe(2);
  });
});

describe("accumulate/finalize streaming equals one-shot aggregate", () => {
  it("feeding files one at a time into a shared accumulator matches aggregateClaudeLines", () => {
    const fileA = [
      assistantLine({
        ts: "2026-06-10T12:00:00Z",
        model: "claude-opus-4-8",
        reqId: "rA",
        msgId: "mA",
        output: 10,
      }),
      assistantLine({
        ts: "2026-06-10T12:00:00Z",
        model: "claude-opus-4-8",
        reqId: "rA",
        msgId: "mA",
        output: 99,
      }), // dup, higher
    ];
    const fileB = [
      assistantLine({
        ts: "2026-06-10T12:00:00Z",
        model: "claude-opus-4-8",
        reqId: "rB",
        msgId: "mB",
        output: 20,
      }),
    ];
    const acc: ClaudeAccumulator = new Map();
    accumulateClaudeLines(acc, fileA);
    accumulateClaudeLines(acc, fileB);
    const streamed = finalizeClaudeEntries(acc);
    const oneShot = aggregateClaudeLines([...fileA, ...fileB]);
    expect(streamed).toEqual(oneShot);
    expect(streamed[0].outputTokens).toBe(119); // 99 (deduped) + 20
    expect(streamed[0].requestCount).toBe(2);
  });
});

describe("collectClaudeNative — streaming + wall-clock budget", () => {
  it("reads correctly within budget and bows out (found:false) when over budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-claude-"));
    const proj = join(dir, "projects", "p");
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, "s.jsonl"),
      assistantLine({
        ts: "2026-06-10T12:00:00Z",
        model: "claude-opus-4-8",
        reqId: "r1",
        msgId: "m1",
        output: 100,
      }) + "\n",
    );
    // Point the per-file cache at the temp dir too, so the test never touches
    // the real config dir.
    const env = {
      CLAUDE_CONFIG_DIR: dir,
      WHOBURNEDMORE_CONFIG_DIR: dir,
    } as NodeJS.ProcessEnv;
    try {
      const ok = await collectClaudeNative(env, { budgetMs: 5000 });
      expect(ok.found).toBe(true);
      expect(ok.entries[0].outputTokens).toBe(100);
      expect(ok.entries[0].requestCount).toBe(1);
      // Expired budget + WARM cache: cache hits are free, so the read still
      // completes — the budget only gates actual file reads now.
      const warm = await collectClaudeNative(env, { budgetMs: -1 });
      expect(warm.found).toBe(true);
      expect(warm.entries[0].outputTokens).toBe(100);
      // Expired budget + COLD cache → abandon to the ccusage fallback, never
      // crash or submit a partial corpus.
      const out = await collectClaudeNative(env, {
        budgetMs: -1,
        cachePath: join(dir, "cold-cache.json"),
      });
      expect(out.found).toBe(false);
      expect(out.timedOut).toBe(true);
      expect(out.entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveClaudeProjectDirs", () => {
  it("defaults to BOTH ~/.claude and ~/.config/claude projects roots", () => {
    const dirs = resolveClaudeProjectDirs({} as NodeJS.ProcessEnv);
    expect(
      dirs.some((d) => d.includes(".claude") && d.endsWith("projects")),
    ).toBe(true);
    expect(
      dirs.some((d) => d.includes(".config") && d.endsWith("projects")),
    ).toBe(true);
    expect(dirs).toHaveLength(2);
  });

  it("honors CLAUDE_CONFIG_DIR as a comma-separated list", () => {
    const dirs = resolveClaudeProjectDirs({
      CLAUDE_CONFIG_DIR: "/a/one, /b/two",
    } as NodeJS.ProcessEnv);
    expect(dirs).toEqual([
      path.join("/a/one", "projects"),
      path.join("/b/two", "projects"),
    ]);
  });
});
