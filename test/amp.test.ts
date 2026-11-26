import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMP_TOOL,
  ampModelsTableFound,
  collectAmp,
  isAmpDayFinal,
  loadAmpCache,
  normalizeAmpModelName,
  parseAmpActiveDates,
  parseAmpModelsTable,
  resolveAmpBin,
} from "../src/amp.js";
import {
  mapCcusageDaily,
  normalizeCcusageModelName,
  selectAmpEntries,
} from "../src/collect.js";
import { DailyUsageEntry, SubmitPayload } from "../src/shared.js";
import { sanitizeDailyEntries } from "../src/wire-sanitize.js";

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

const SAMPLE_OVERVIEW = `# Usage

Range: 2026-09-01T00:00:00.000Z to 2026-11-27T00:00:00.000Z (end exclusive)

## Daily Recorded Cost

| Date (UTC) | Included orb hours | Covered | Paid | Total |
| --- | ---: | ---: | ---: | ---: |
| 2026-11-21 | 1h | $0.01 | $0.00 | $0.01 |
| 2026-11-23 | 0h | $0.00 | $0.00 | $0.00 |
| 2099-01-01 | 0h | $0.00 | $0.00 | $0.00 |

## Top Threads by Tokens
`;

const SAMPLE_DAY_REPORT = `# Usage

## Models

Sorted by recorded cost. Uncached input, cache read, cache write, and output tokens add up to Tokens.

| Model | Uncached input | Cache read | Cache write | Output | Tokens | Recorded cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Opus 5.5 | 2,068 | 152,719,341 | 8,173,406 | 1,687,051 | 162,581,866 | $0.34 |
| GPT-6.1 Sol | 10,000 | 500,000 | 0 | 2,000 | 512,000 | $0.00 |
| Gemini 3.7 Flash | 2,083 | 0 | 0 | 823 | 2,906 | $0.006 |
| GPT-Transcribe | 0 | 0 | 0 | 0 | 0 | $0.04 |
| Empty Model | 0 | 0 | 0 | 0 | 0 | $0.00 |

## Daily Recorded Cost
`;

describe("normalizeAmpModelName", () => {
  it("normalizes Amp display names to clean wire-safe identifiers", () => {
    // Claude versions use dashes, like every other collector reports them.
    expect(normalizeAmpModelName("Opus 5.5")).toBe("claude-opus-5-5");
    expect(normalizeAmpModelName("Sonnet 4.6")).toBe("claude-sonnet-4-6");
    expect(normalizeAmpModelName("Haiku 4.5")).toBe("claude-haiku-4-5");
    expect(normalizeAmpModelName("Claude Opus 4.6")).toBe("claude-opus-4-6");
    expect(normalizeAmpModelName("GPT-6.1 Sol")).toBe("gpt-6.1-sol");
    expect(normalizeAmpModelName("Gemini 3.7 Flash")).toBe("gemini-3.7-flash");
    expect(normalizeAmpModelName("GPT-Image-2.5 Sunburst")).toBe("gpt-image-2.5-sunburst");
    expect(normalizeAmpModelName("")).toBe(AMP_TOOL);
  });
});

describe("parseAmpActiveDates & parseAmpModelsTable", () => {
  it("extracts plausible active UTC dates newest-first", () => {
    expect(parseAmpActiveDates(SAMPLE_OVERVIEW, NOW)).toEqual(["2026-11-23", "2026-11-21"]);
  });

  it("parses exact per-model token buckets, keeps recorded cost, and passes schema + wire sanitizer", () => {
    const entries = parseAmpModelsTable(SAMPLE_DAY_REPORT, "2026-11-23");
    // GPT-Transcribe (cost, no tokens) and Empty Model are dropped.
    expect(entries).toHaveLength(3);

    const opus = entries.find((e) => e.model === "claude-opus-5-5")!;
    expect(opus).toEqual({
      date: "2026-11-23",
      tool: AMP_TOOL,
      model: "claude-opus-5-5",
      inputTokens: 2068,
      outputTokens: 1687051,
      cacheCreationTokens: 8173406,
      cacheReadTokens: 152719341,
      costUSD: 0.34,
      origin: "cli",
      verified: false,
    });

    const gpt = entries.find((e) => e.model === "gpt-6.1-sol")!;
    expect(gpt).toMatchObject({
      inputTokens: 10000,
      outputTokens: 2000,
      cacheReadTokens: 500000,
    });

    const gemini = entries.find((e) => e.model === "gemini-3.7-flash")!;
    expect(gemini.costUSD).toBeCloseTo(0.006, 6);

    // The server rejects a whole upload that carries a cost-but-no-tokens row.
    expect(entries.find((e) => e.model === "gpt-transcribe")).toBeUndefined();
    for (const e of entries) {
      expect(e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens).toBeGreaterThan(0);
    }

    // Every normalized model survives sanitizeDailyEntries without hashing.
    const sanitized = sanitizeDailyEntries(entries);
    expect(sanitized.map((e) => e.model)).toEqual(entries.map((e) => e.model));
    for (const e of sanitized) expect(() => DailyUsageEntry.parse(e)).not.toThrow();
    expect(() => SubmitPayload.parse({ cliVersion: "0.9.28", entries: sanitized })).not.toThrow();
  });

  it("estimates USD from pricing table when a linked provider records $0.00 for a known model", () => {
    const report = `## Models
| Model | Uncached input | Cache read | Cache write | Output | Tokens | Recorded cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Opus 5.5 | 1,000,000 | 0 | 0 | 100,000 | 1,100,000 | $0.00 |
`;
    const entries = parseAmpModelsTable(report, "2026-11-23");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.costUSD).toBeGreaterThan(0);
  });
});

describe("server limits on Amp rows", () => {
  it("caps cost per token below the API's $200 per million ceiling", () => {
    const report = `## Models
| Model | Uncached input | Cache read | Cache write | Output | Tokens | Recorded cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-Image-2.5 Sunburst | 40 | 0 | 0 | 0 | 40 | $0.04 |
`;
    const [row] = parseAmpModelsTable(report, "2026-11-23");
    expect(row).toBeDefined();
    const tokens = row!.inputTokens + row!.outputTokens + row!.cacheCreationTokens + row!.cacheReadTokens;
    expect(row!.costUSD).toBeGreaterThan(0);
    expect(row!.costUSD).toBeLessThanOrEqual((tokens * 200) / 1_000_000);
  });

  it("caps cached rows written by an older build too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-amp-capcache-"));
    const cachePath = join(dir, "amp-usage-cache.json");
    try {
      const row = {
        date: "2026-11-20",
        tool: "amp",
        model: "gpt-image-2.5-sunburst",
        inputTokens: 40,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0.04,
        origin: "cli",
        verified: false,
      };
      writeFileSync(
        cachePath,
        JSON.stringify({ v: 1, lastIndexAt: NOW, activeDates: [], days: { "2026-11-20": { fetchedAt: NOW, entries: [row] } } }),
      );
      const res = await collectAmp({ offline: true, cachePath, now: NOW });
      expect(res.entries[0]!.costUSD).toBeLessThanOrEqual((40 * 200) / 1_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not cache a day whose report it can't read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-amp-unreadable-"));
    const cachePath = join(dir, "amp-usage-cache.json");
    try {
      expect(ampModelsTableFound(SAMPLE_DAY_REPORT)).toBe(true);
      expect(ampModelsTableFound("Error: something went wrong")).toBe(false);
      let readable = false;
      const runner = vi.fn(async (args: string[]) => {
        const start = args[args.indexOf("--start") + 1] ?? "";
        if (start.startsWith("2026-08-")) return SAMPLE_OVERVIEW;
        return readable ? SAMPLE_DAY_REPORT : "Error: something went wrong";
      });
      const first = await collectAmp({ cachePath, now: NOW, runner });
      expect(first.entries).toEqual([]);
      expect(Object.keys(loadAmpCache(cachePath).days)).toEqual([]);
      // Once Amp answers properly, the same days are fetched and counted.
      readable = true;
      const later = await collectAmp({ cachePath, now: NOW + 20 * 60_000, runner });
      expect(new Set(later.entries.map((e) => e.date))).toEqual(new Set(["2026-11-21", "2026-11-23"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isAmpDayFinal", () => {
  it("marks past UTC days fetched after midnight + grace as final", () => {
    const dayEnd = Date.parse("2026-11-24T00:00:00.000Z");
    expect(isAmpDayFinal("2026-11-23", dayEnd + 6 * 60_000)).toBe(true);
    expect(isAmpDayFinal("2026-11-23", dayEnd + 60_000)).toBe(false);
    expect(isAmpDayFinal("2026-11-26", NOW)).toBe(false);
  });
});

describe("collectAmp caching, rate-limit budget, and offline behavior", () => {
  it("caches finalized past days so subsequent runs do not re-fetch them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-amp-cache-"));
    const cachePath = join(dir, "amp-usage-cache.json");
    try {
      const runner = vi.fn(async (args: string[]) => {
        const startIdx = args.indexOf("--start");
        const start = startIdx >= 0 ? args[startIdx + 1] : "";
        if (start.startsWith("2026-08-") || start.startsWith("2026-09-")) {
          return SAMPLE_OVERVIEW;
        }
        return SAMPLE_DAY_REPORT;
      });

      // Cold run: 1 overview + 2 active days = 3 calls
      const first = await collectAmp({ cachePath, now: NOW, runner });
      expect(first.found).toBe(true);
      expect(first.entries.length).toBe(6); // 3 token-bearing models × 2 days
      expect(runner).toHaveBeenCalledTimes(3);

      // Warm run within revalidate window: 0 calls
      const warm = await collectAmp({ cachePath, now: NOW + 60_000, runner });
      expect(warm.entries).toEqual(first.entries);
      expect(runner).toHaveBeenCalledTimes(3);

      // Next sync after revalidate window: only 1 overview call, 0 day calls (both past days are final)
      const later = await collectAmp({ cachePath, now: NOW + 20 * 60_000, runner });
      expect(later.entries).toEqual(first.entries);
      expect(runner).toHaveBeenCalledTimes(4);

      // Offline mode returns cached entries without calling runner
      const offline = await collectAmp({ offline: true, cachePath, now: NOW + 40 * 60_000, runner });
      expect(offline.found).toBe(true);
      expect(offline.entries).toEqual(first.entries);
      expect(runner).toHaveBeenCalledTimes(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps per-run requests and resumes uncached days on the next run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-amp-budget-"));
    const cachePath = join(dir, "amp-usage-cache.json");
    try {
      const runner = vi.fn(async (args: string[]) => {
        const start = args[args.indexOf("--start") + 1] ?? "";
        if (start.startsWith("2026-08-")) return SAMPLE_OVERVIEW;
        return SAMPLE_DAY_REPORT;
      });

      // Budget 2: 1 overview + 1 newest day (2026-11-23)
      const r1 = await collectAmp({ cachePath, now: NOW, maxRequestsPerRun: 2, runner });
      expect(new Set(r1.entries.map((e) => e.date))).toEqual(new Set(["2026-11-23"]));
      expect(runner).toHaveBeenCalledTimes(2);

      // Next run (within overview window): fetches the remaining older day (2026-11-21)
      const r2 = await collectAmp({ cachePath, now: NOW + 60_000, maxRequestsPerRun: 2, runner });
      expect(new Set(r2.entries.map((e) => e.date))).toEqual(new Set(["2026-11-23", "2026-11-21"]));
      expect(runner).toHaveBeenCalledTimes(3);
      expect(Object.keys(loadAmpCache(cachePath).days).sort()).toEqual(["2026-11-21", "2026-11-23"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never spends more than the default budget of 8 Amp lookups in one run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-amp-default-budget-"));
    const cachePath = join(dir, "amp-usage-cache.json");
    try {
      // 30 active days in the overview: a cold run must stop at 1 overview + 7 days.
      const rows = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(NOW - (i + 1) * 86_400_000).toISOString().slice(0, 10);
        return `| ${d} | 0h | $0.01 | $0.00 | $0.01 |`;
      }).join("\n");
      const overview = `## Daily Recorded Cost\n\n| Date (UTC) | Included orb hours | Covered | Paid | Total |\n| --- | ---: | ---: | ---: | ---: |\n${rows}\n`;
      const runner = vi.fn(async (args: string[]) => {
        const start = args[args.indexOf("--start") + 1] ?? "";
        const end = args[args.indexOf("--end") + 1] ?? "";
        const spanDays = (Date.parse(end) - Date.parse(start)) / 86_400_000;
        return spanDays > 1 ? overview : SAMPLE_DAY_REPORT;
      });
      await collectAmp({ cachePath, now: NOW, runner });
      expect(runner).toHaveBeenCalledTimes(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops malformed or token-less cached rows instead of uploading them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-amp-corrupt-"));
    const cachePath = join(dir, "amp-usage-cache.json");
    try {
      const good = {
        date: "2026-11-20",
        tool: "amp",
        model: "claude-opus-4-6",
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0.0001,
        origin: "cli",
        verified: false,
      };
      writeFileSync(
        cachePath,
        JSON.stringify({
          v: 1,
          lastIndexAt: NOW,
          activeDates: ["2026-11-20"],
          days: {
            "2026-11-20": {
              fetchedAt: NOW,
              entries: [
                good,
                { ...good, model: "cost-only", inputTokens: 0, outputTokens: 0, costUSD: 1 },
                { ...good, model: "negative", inputTokens: -5 },
                { ...good, model: "wrong-day", date: "2026-11-19" },
                { ...good, model: "wrong-tool", tool: "claude" },
                { ...good, model: "nan-cost", costUSD: Number.NaN },
                "garbage",
              ],
            },
          },
        }),
      );
      const res = await collectAmp({ offline: true, cachePath, now: NOW });
      expect(res.entries).toEqual([good]);
      expect(() => SubmitPayload.parse({ cliVersion: "0.9.29", entries: res.entries })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes cached days older than the retention window when it saves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-amp-prune-"));
    const cachePath = join(dir, "amp-usage-cache.json");
    try {
      writeFileSync(
        cachePath,
        JSON.stringify({ v: 1, activeDates: ["2025-01-01"], days: { "2025-01-01": { fetchedAt: NOW, entries: [] } } }),
      );
      const runner = vi.fn(async (args: string[]) => {
        const start = args[args.indexOf("--start") + 1] ?? "";
        return start.startsWith("2026-08-") ? SAMPLE_OVERVIEW : SAMPLE_DAY_REPORT;
      });
      await collectAmp({ cachePath, now: NOW, runner });
      const cache = loadAmpCache(cachePath);
      expect(Object.keys(cache.days)).not.toContain("2025-01-01");
      expect(cache.activeDates).not.toContain("2025-01-01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects WHOBURNEDMORE_AMP=0 and rejects world-writable amp binaries", async () => {
    const runner = vi.fn();
    const disabled = await collectAmp({ env: { WHOBURNEDMORE_AMP: "0" }, runner });
    expect(disabled).toEqual({ entries: [], found: false });
    expect(runner).not.toHaveBeenCalled();

    if (process.platform !== "win32") {
      const dir = mkdtempSync(join(tmpdir(), "wbm-amp-bin-"));
      try {
        const bin = join(dir, "amp");
        writeFileSync(bin, "#!/bin/sh\nexit 0\n");
        chmodSync(bin, 0o777);
        expect(resolveAmpBin({ AMP_BIN: bin })).toBeNull();
        chmodSync(bin, 0o755);
        expect(resolveAmpBin({ AMP_BIN: bin })).toBeTruthy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("selectAmpEntries & Pi ccusage model normalization", () => {
  const row = (tool: string, model: string, inputTokens: number): DailyUsageEntry => ({
    date: "2026-11-23",
    tool,
    model,
    inputTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    origin: "cli",
    verified: false,
  });

  it("prefers modern Amp CLI entries over legacy ccusage amp without double counting", () => {
    expect(selectAmpEntries({ found: true, entries: [row("amp", "claude-opus-5.5", 100)] }, [row("amp", "old", 50)])).toEqual([
      row("amp", "claude-opus-5.5", 100),
    ]);
    expect(selectAmpEntries({ found: false, entries: [] }, [row("amp", "old", 50)])).toEqual([
      row("amp", "old", 50),
    ]);
  });

  it("strips [pi] store prefix from ccusage pi model names so wire-sanitize preserves real models", () => {
    expect(normalizeCcusageModelName("[pi] gpt-6-astra")).toBe("gpt-6-astra");
    expect(normalizeCcusageModelName("[pi] gemini-4-neon")).toBe("gemini-4-neon");
    expect(normalizeCcusageModelName("claude-opus-4-6")).toBe("claude-opus-4-6");
    // OpenClaw carries the same ccusage store prefix.
    expect(normalizeCcusageModelName("[openclaw] claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeCcusageModelName("[pi] ")).toBe("[pi]");
    expect(normalizeCcusageModelName(undefined)).toBe("unknown");

    const mapped = mapCcusageDaily(
      "pi",
      {
        daily: [
          {
            date: "2026-11-23",
            modelBreakdowns: [
              {
                modelName: "[pi] gpt-6-astra",
                inputTokens: 100,
                outputTokens: 50,
                cacheCreationTokens: 0,
                cacheReadTokens: 200,
                cost: 0.12,
              },
            ],
          },
        ],
      },
      NOW,
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.model).toBe("gpt-6-astra");
    const sanitized = sanitizeDailyEntries(mapped);
    expect(sanitized[0]!.model).toBe("gpt-6-astra");
  });
});
