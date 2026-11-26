import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMP_TOOL,
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
    expect(normalizeAmpModelName("Opus 5.5")).toBe("claude-opus-5.5");
    expect(normalizeAmpModelName("Sonnet 4.6")).toBe("claude-sonnet-4.6");
    expect(normalizeAmpModelName("Haiku 4.5")).toBe("claude-haiku-4.5");
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
    expect(entries).toHaveLength(4);

    const opus = entries.find((e) => e.model === "claude-opus-5.5")!;
    expect(opus).toEqual({
      date: "2026-11-23",
      tool: AMP_TOOL,
      model: "claude-opus-5.5",
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

    const transcribe = entries.find((e) => e.model === "gpt-transcribe")!;
    expect(transcribe.costUSD).toBeCloseTo(0.04, 6);

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
      expect(first.entries.length).toBe(8); // 4 models × 2 days
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
