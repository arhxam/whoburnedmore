import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DailyUsageEntry } from "./shared.js";
import { estimateCostUSD } from "./pricing.js";

// Fallback Cursor source: the community-maintained `tokscale` CLI. The primary
// path (src/cursor.ts) calls Cursor's dashboard API directly; if Cursor changes
// that endpoint, this fallback reads the user's tokscale-synced Cursor cache so
// resilience is a `tokscale` version bump rather than a patch to our code.
// tokscale's JSON has no per-day grouping, so we query one day at a time — but
// only after a single probe confirms there's any Cursor data to fetch.

const LOOKBACK_DAYS = 30;

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function numCost(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

interface TokscaleEntry {
  model?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

/**
 * Map one tokscale `--json` report (its `entries[]`, grouped by model) for a
 * single day into our daily entries. Pure + tested. Reasoning tokens fold into
 * output since our schema has no separate reasoning bucket.
 */
export function mapTokscaleDay(date: string, json: unknown): DailyUsageEntry[] {
  const entries = (json as { entries?: TokscaleEntry[] } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  const out: DailyUsageEntry[] = [];
  for (const e of entries) {
    const inputTokens = num(e.input);
    const outputTokens = num(e.output) + num(e.reasoning);
    const cacheCreationTokens = num(e.cacheWrite);
    const cacheReadTokens = num(e.cacheRead);
    const model = typeof e.model === "string" && e.model ? e.model : "cursor";
    const billed = numCost(e.cost);
    const costUSD =
      billed > 0
        ? billed
        : estimateCostUSD(model, {
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
          });
    const total = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    if (total === 0 && costUSD === 0) continue;
    out.push({
      date,
      tool: "cursor",
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUSD,
      origin: "cli",
      verified: false,
    });
  }
  return out;
}

/** Locate the tokscale executable if it's installed; null if absent. */
export function resolveTokscaleBin(): { cmd: string; prefixArgs: string[] } | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("tokscale/package.json");
    const pkg = require("tokscale/package.json") as {
      bin?: string | Record<string, string>;
    };
    const rel =
      typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.tokscale ?? "");
    if (!rel) return null;
    const binPath = join(dirname(pkgPath), rel);
    if (/\.(c|m)?js$/.test(binPath)) {
      return { cmd: process.execPath, prefixArgs: [binPath] };
    }
    return { cmd: binPath, prefixArgs: [] };
  } catch {
    return null;
  }
}

function runTokscaleDay(
  bin: { cmd: string; prefixArgs: string[] },
  day: string,
): unknown | null {
  const res = spawnSync(
    bin.cmd,
    [
      ...bin.prefixArgs,
      "--client",
      "cursor",
      "--json",
      "--since",
      day,
      "--until",
      day,
      "--group-by",
      "model",
      "--no-spinner",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
  );
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/**
 * Read Cursor usage from tokscale's synced cache, one day at a time. Returns []
 * when tokscale isn't installed or has no Cursor data (a single probe day gates
 * the per-day loop, so users without tokscale Cursor pay one cheap call).
 */
export function collectCursorViaTokscale(
  lookbackDays = LOOKBACK_DAYS,
): DailyUsageEntry[] {
  const bin = resolveTokscaleBin();
  if (!bin) return [];

  const today = new Date();
  // LOCAL calendar days, matching the native readers' bucketing — a UTC slice
  // asks tokscale for the wrong day (and labels rows with it) east of UTC.
  const day = (offset: number) => {
    const d = new Date(today.getTime() - offset * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // Probe today first; if there's no Cursor data at all, don't spawn 30 more.
  if (mapTokscaleDay(day(0), runTokscaleDay(bin, day(0))).length === 0) {
    // Probe one more recent day in case today is simply empty.
    if (mapTokscaleDay(day(1), runTokscaleDay(bin, day(1))).length === 0) {
      return [];
    }
  }

  const out: DailyUsageEntry[] = [];
  for (let i = 0; i < lookbackDays; i++) {
    const d = day(i);
    out.push(...mapTokscaleDay(d, runTokscaleDay(bin, d)));
  }
  return out;
}
