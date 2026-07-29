import { describe, expect, it } from "vitest";
import {
  capByTokens,
  ccusageClaudeEnv,
  dedupeBlocks,
  dedupeDaily,
  dedupeSessions,
  isAuthoritativeScan,
  mapCcusageBlocks,
  mapCcusageDaily,
  mapCcusageSessions,
  selectSourceEntries,
} from "../src/collect.js";
import type { DailyUsageEntry } from "../src/shared.js";
import type { NativeCollectResult } from "../src/native/claude.js";

const nativeEntry = (tool: string, requestCount: number): DailyUsageEntry => ({
  date: "2026-06-10",
  tool,
  model: tool === "claude" ? "claude-opus-4-8" : "gpt-5-codex",
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0.01,
  origin: "cli",
  verified: false,
  requestCount,
});
const ccEntry = (tool: string): DailyUsageEntry => ({
  date: "2026-06-10",
  tool,
  model: "fallback-model",
  inputTokens: 999,
  outputTokens: 999,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUSD: 9.99,
  origin: "cli",
  verified: false,
});
const found = (entries: DailyUsageEntry[]): NativeCollectResult => ({
  entries,
  found: true,
  filesScanned: entries.length,
});
const notFound: NativeCollectResult = { entries: [], found: false, filesScanned: 0 };

describe("isAuthoritativeScan (anti-regression guard gating)", () => {
  const ok = { timedOut: false };
  const bailed = { timedOut: true };
  // A thrown native reader's catch-fallback in collectAll() (found:false,
  // timedOut:true) — a bailed scan, NOT genuine emptiness.
  const threw: Pick<NativeCollectResult, "timedOut"> = { timedOut: true };
  // A genuinely-empty reader returns found:false with no timedOut.
  const empty: Pick<NativeCollectResult, "timedOut"> = {};

  it("is authoritative when attribution finished and neither reader bailed", () => {
    expect(isAuthoritativeScan(true, ok, ok)).toBe(true);
  });

  it("is NOT authoritative when the attribution scan is partial", () => {
    expect(isAuthoritativeScan(false, ok, ok)).toBe(false);
  });

  it("is NOT authoritative when a native reader timed out", () => {
    expect(isAuthoritativeScan(true, bailed, ok)).toBe(false);
    expect(isAuthoritativeScan(true, ok, bailed)).toBe(false);
  });

  it("is NOT authoritative when a native reader THREW (catch sets timedOut:true)", () => {
    // The regression this guards: a mid-parse throw on data ccusage can still
    // read must not be trusted as a full snapshot, or the day's requestCount
    // fingerprint regresses to zero and reads as forgery.
    expect(isAuthoritativeScan(true, threw, ok)).toBe(false);
    expect(isAuthoritativeScan(true, ok, threw)).toBe(false);
  });

  it("stays authoritative for a genuinely-empty reader (found:false, no bail)", () => {
    // No timeout/throw → "nothing here" is real (shares ccusage's data source),
    // so the run may legitimately refresh a fingerprint down.
    expect(isAuthoritativeScan(true, empty, empty)).toBe(true);
  });
});

describe("selectSourceEntries", () => {
  it("prefers the native reader for claude/codex when it found transcripts", () => {
    const native = { claude: found([nativeEntry("claude", 42)]), codex: found([nativeEntry("codex", 7)]) };
    const claude = selectSourceEntries("claude", [ccEntry("claude")], native);
    expect(claude).toHaveLength(1);
    expect(claude[0].requestCount).toBe(42);
    expect(claude[0].model).toBe("claude-opus-4-8"); // native, not the ccusage fallback
    const codex = selectSourceEntries("codex", [ccEntry("codex")], native);
    expect(codex[0].requestCount).toBe(7);
  });

  it("falls back to ccusage when the native reader found nothing on disk", () => {
    const native = { claude: notFound, codex: notFound };
    const claude = selectSourceEntries("claude", [ccEntry("claude")], native);
    expect(claude[0].model).toBe("fallback-model");
    expect(claude[0].requestCount).toBeUndefined();
  });

  it("falls back to ccusage when the native reader found files but no usage", () => {
    const native = { claude: found([]), codex: found([]) };
    const claude = selectSourceEntries("claude", [ccEntry("claude")], native);
    expect(claude[0].model).toBe("fallback-model");
  });

  it("never substitutes native entries for a non-primary source", () => {
    const native = { claude: found([nativeEntry("claude", 1)]), codex: found([nativeEntry("codex", 1)]) };
    const gemini = selectSourceEntries("gemini", [ccEntry("gemini")], native);
    expect(gemini[0].model).toBe("fallback-model");
  });
});

describe("ccusageClaudeEnv (dual config-dir hardening)", () => {
  it("forces CLAUDE_CONFIG_DIR to BOTH roots when unset", () => {
    const out = ccusageClaudeEnv({} as NodeJS.ProcessEnv);
    const dir = out.CLAUDE_CONFIG_DIR ?? "";
    expect(dir).toContain(".claude");
    expect(dir).toContain(".config");
    expect(dir.split(",")).toHaveLength(2);
  });

  it("respects a user-set CLAUDE_CONFIG_DIR verbatim", () => {
    const out = ccusageClaudeEnv({ CLAUDE_CONFIG_DIR: "/only/here" } as NodeJS.ProcessEnv);
    expect(out.CLAUDE_CONFIG_DIR).toBe("/only/here");
  });
});

describe("dedupeDaily — request fingerprint", () => {
  it("sums requestCount when collapsing same-key rows", () => {
    const merged = dedupeDaily([nativeEntry("claude", 3), nativeEntry("claude", 4)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].requestCount).toBe(7);
  });
});

describe("capByTokens", () => {
  const tok = (n: number) => ({ totalTokens: n });
  it("is a no-op when within the limit (order preserved)", () => {
    const rows = [tok(1), tok(2), tok(3)];
    expect(capByTokens(rows, 10, (r) => r.totalTokens)).toEqual(rows);
  });
  it("caps to the max, keeping the highest-token rows", () => {
    const rows = [tok(5), tok(100), tok(1), tok(50), tok(2)];
    const capped = capByTokens(rows, 2, (r) => r.totalTokens);
    expect(capped).toHaveLength(2);
    expect(capped.map((r) => r.totalTokens).sort((a, b) => a - b)).toEqual([50, 100]);
  });
  it("never exceeds the server's session/blocks ceiling for an oversized store", () => {
    const rows = Array.from({ length: 12000 }, (_, i) => tok(i));
    expect(capByTokens(rows, 10000, (r) => r.totalTokens)).toHaveLength(10000);
  });
});

// Shape captured from `ccusage claude daily --json --offline` (v20).
const claudeFixture = {
  daily: [
    {
      date: "2026-05-11",
      inputTokens: 81094,
      outputTokens: 634097,
      cacheCreationTokens: 3381237,
      cacheReadTokens: 101250981,
      totalTokens: 105347409,
      totalCost: 78.305,
      modelsUsed: ["claude-opus-4-7", "claude-sonnet-4-6"],
      modelBreakdowns: [
        {
          modelName: "claude-opus-4-7",
          inputTokens: 26864,
          outputTokens: 393640,
          cacheCreationTokens: 1897212,
          cacheReadTokens: 76636285,
          cost: 64.812,
        },
        {
          modelName: "claude-sonnet-4-6",
          inputTokens: 1797,
          outputTokens: 165467,
          cacheCreationTokens: 645704,
          cacheReadTokens: 14567451,
          cost: 10.731,
        },
      ],
    },
  ],
};

describe("mapCcusageDaily", () => {
  it("maps one entry per day per model with the tool attached", () => {
    const entries = mapCcusageDaily("claude", claudeFixture);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      date: "2026-05-11",
      tool: "claude",
      model: "claude-opus-4-7",
      inputTokens: 26864,
      outputTokens: 393640,
      cacheCreationTokens: 1897212,
      cacheReadTokens: 76636285,
      costUSD: 64.812,
      origin: "cli",
      verified: false,
    });
    expect(entries[1].model).toBe("claude-sonnet-4-6");
  });

  it("falls back to day totals when there are no model breakdowns", () => {
    const entries = mapCcusageDaily("codex", {
      daily: [
        {
          date: "2026-06-01",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0.01,
          modelBreakdowns: [],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("unknown");
    expect(entries[0].inputTokens).toBe(100);
    expect(entries[0].costUSD).toBe(0.01);
  });

  it("accepts the aggregate format that uses `period` instead of `date`", () => {
    const entries = mapCcusageDaily("codex", {
      daily: [
        {
          period: "2026-06-02",
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0,
          modelBreakdowns: [
            {
              modelName: "gpt-5.3-codex",
              inputTokens: 10,
              outputTokens: 5,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              cost: 0,
            },
          ],
        },
      ],
    });
    expect(entries[0].date).toBe("2026-06-02");
  });

  it("rounds fractional token counts and clamps negatives to zero", () => {
    const entries = mapCcusageDaily("gemini", {
      daily: [
        {
          date: "2026-06-03",
          modelBreakdowns: [
            {
              modelName: "gemini-3-pro",
              inputTokens: 10.6,
              outputTokens: -3,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              cost: 0.5,
            },
          ],
        },
      ],
    });
    expect(entries[0].inputTokens).toBe(11);
    expect(entries[0].outputTokens).toBe(0);
  });

  it("skips days with no tokens at all", () => {
    const entries = mapCcusageDaily("claude", {
      daily: [
        {
          date: "2026-06-04",
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0,
          modelBreakdowns: [],
        },
      ],
    });
    expect(entries).toHaveLength(0);
  });

  // Shape captured from `ccusage codex daily --json` (v20): a `models` object
  // map instead of modelBreakdowns, and day-level `costUSD`.
  it("maps the codex per-source format with a models object map", () => {
    const entries = mapCcusageDaily("codex", {
      daily: [
        {
          date: "2026-02-03",
          inputTokens: 334110,
          outputTokens: 5512,
          reasoningOutputTokens: 2176,
          cacheCreationTokens: 0,
          cacheReadTokens: 1151744,
          costUSD: 0.8634,
          totalTokens: 1491366,
          models: {
            "gpt-5.2-codex": {
              inputTokens: 334110,
              outputTokens: 5512,
              reasoningOutputTokens: 2176,
              cacheCreationTokens: 0,
              cacheReadTokens: 1151744,
              totalTokens: 1491366,
              isFallback: false,
            },
          },
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("gpt-5.2-codex");
    expect(entries[0].inputTokens).toBe(334110);
    expect(entries[0].costUSD).toBeCloseTo(0.8634);
  });

  it("splits day-level cost across the models map proportionally to tokens", () => {
    const entries = mapCcusageDaily("codex", {
      daily: [
        {
          date: "2026-02-04",
          costUSD: 10,
          models: {
            "gpt-a": { inputTokens: 750, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            "gpt-b": { inputTokens: 250, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
          },
        },
      ],
    });
    expect(entries).toHaveLength(2);
    const a = entries.find((e) => e.model === "gpt-a")!;
    const b = entries.find((e) => e.model === "gpt-b")!;
    expect(a.costUSD).toBeCloseTo(7.5);
    expect(b.costUSD).toBeCloseTo(2.5);
  });

  it("uses day-level costUSD in the no-breakdown fallback", () => {
    const entries = mapCcusageDaily("codex", {
      daily: [
        {
          date: "2026-06-01",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUSD: 0.25,
        },
      ],
    });
    expect(entries[0].costUSD).toBe(0.25);
  });

  // Shape captured from `ccusage droid|opencode daily --json` (v20): day-level
  // tokens + a `modelsUsed` list, no modelBreakdowns and no models map.
  it("attributes a single-model day to its model via modelsUsed (droid/opencode)", () => {
    const entries = mapCcusageDaily("droid", {
      daily: [
        {
          date: "2026-05-02",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 200,
          totalCost: 1.5,
          modelsUsed: ["claude-opus-4-7"],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("claude-opus-4-7");
    expect(entries[0].inputTokens).toBe(100);
    expect(entries[0].costUSD).toBe(1.5);
  });

  it("keeps a mixed-model day as 'unknown' (can't split day-level tokens)", () => {
    const entries = mapCcusageDaily("opencode", {
      daily: [
        {
          date: "2026-05-03",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0.25,
          modelsUsed: ["gpt-5.2-codex", "claude-sonnet-4-6"],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("unknown");
  });

  it("falls back to 'unknown' when modelsUsed is absent", () => {
    const entries = mapCcusageDaily("droid", {
      daily: [
        {
          date: "2026-05-04",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0.1,
        },
      ],
    });
    expect(entries[0].model).toBe("unknown");
  });

  it("returns no entries for malformed output", () => {
    expect(mapCcusageDaily("claude", null)).toEqual([]);
    expect(mapCcusageDaily("claude", { nope: true })).toEqual([]);
  });
});

// Shape captured from `ccusage session --json --offline` (v20).
describe("mapCcusageSessions", () => {
  const sessionFixture = {
    session: [
      {
        agent: "claude",
        period: "00d122ca-5acd-4655-902c-7dee4522f86f",
        modelsUsed: ["claude-opus-4-7"],
        inputTokens: 15,
        outputTokens: 3036,
        cacheCreationTokens: 16408,
        cacheReadTokens: 266674,
        totalCost: 0.3734,
        metadata: { lastActivity: "2026-05-14T23:29:52.093Z" },
      },
      // Zero-token session is dropped.
      { agent: "codex", period: "empty", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 },
    ],
  };

  it("maps a session to a per-conversation entry with id, tool, model, cost, lastActivity", () => {
    const out = mapCcusageSessions(sessionFixture);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      sessionId: "00d122ca-5acd-4655-902c-7dee4522f86f",
      tool: "claude",
      model: "claude-opus-4-7",
      inputTokens: 15,
      outputTokens: 3036,
      cacheCreationTokens: 16408,
      cacheReadTokens: 266674,
      costUSD: 0.3734,
      lastActivity: "2026-05-14T23:29:52.093Z",
    });
  });

  it("returns [] for malformed output", () => {
    expect(mapCcusageSessions(null)).toEqual([]);
    expect(mapCcusageSessions({ nope: 1 })).toEqual([]);
  });
});

// Shape captured from `ccusage blocks --json --offline` (v20).
describe("mapCcusageBlocks", () => {
  const blockFixture = {
    blocks: [
      { startTime: "2026-05-14T01:00:00.000Z", endTime: "2026-05-14T06:00:00.000Z", totalTokens: 2874420, costUSD: 3.83, isGap: false },
      { startTime: "2026-05-14T06:25:20.526Z", totalTokens: 0, costUSD: 0, isGap: false }, // empty
      { startTime: "2026-05-14T12:00:00.000Z", totalTokens: 999, costUSD: 1, isGap: true }, // gap
    ],
  };

  it("keeps non-empty, non-gap windows with start time + totals", () => {
    const out = mapCcusageBlocks(blockFixture);
    expect(out).toEqual([
      { startTime: "2026-05-14T01:00:00.000Z", totalTokens: 2874420, costUSD: 3.83 },
    ]);
  });

  it("returns [] for malformed output", () => {
    expect(mapCcusageBlocks(null)).toEqual([]);
    expect(mapCcusageBlocks({ nope: 1 })).toEqual([]);
  });
});

describe("dedupe before send (prevents API duplicate-key 500s)", () => {
  const daily = (over: Record<string, unknown> = {}) => ({
    date: "2026-06-09",
    tool: "claude",
    model: "claude-sonnet-4-6",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 200,
    costUSD: 1,
    origin: "cli" as const,
    verified: false,
    ...over,
  });

  it("sums daily entries that share (date,tool,model,origin)", () => {
    const out = dedupeDaily([daily(), daily()]);
    expect(out).toHaveLength(1);
    expect(out[0].inputTokens).toBe(200);
    expect(out[0].cacheReadTokens).toBe(400);
    expect(out[0].costUSD).toBe(2);
  });

  it("keeps distinct (date,tool,model,origin) rows separate", () => {
    const out = dedupeDaily([daily(), daily({ model: "claude-opus-4-7" })]);
    expect(out).toHaveLength(2);
  });

  it("drops duplicate session ids, keeping the largest", () => {
    const s = (over: Record<string, unknown>) => ({
      sessionId: "abc",
      tool: "claude",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      lastActivity: "2026-06-09T00:00:00.000Z",
      ...over,
    });
    const out = dedupeSessions([s({ inputTokens: 10 }), s({ inputTokens: 99 })]);
    expect(out).toHaveLength(1);
    expect(out[0].inputTokens).toBe(99);
  });

  it("merges blocks that share a start time", () => {
    const out = dedupeBlocks([
      { startTime: "2026-06-09T12:00:00.000Z", totalTokens: 100, costUSD: 1 },
      { startTime: "2026-06-09T12:00:00.000Z", totalTokens: 50, costUSD: 0.5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].totalTokens).toBe(150);
    expect(out[0].costUSD).toBe(1.5);
  });
});
