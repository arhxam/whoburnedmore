/**
 * Native reader for Continue.dev (VS Code / JetBrains extension).
 *
 * Continue writes a purpose-built local "development data" log at
 * `~/.continue/dev_data/<schema>/*.jsonl` — one JSON object per line. The
 * `tokensGenerated` events record a model, prompt/generated token counts, and a
 * timestamp, which is exactly a per-request usage row. `ccusage` can't read
 * Continue, so we parse the JSONL ourselves.
 *
 * Best-effort + defensive: Continue's event schema is versioned and not a stable
 * contract, so we require a model, a parseable timestamp, and a non-zero token
 * count, and silently skip any record that doesn't match. When Continue isn't
 * installed there's no `dev_data` dir and the reader returns `found:false`. Cache
 * tokens aren't recorded by Continue, so those fields are 0 and cost is
 * estimated from the model.
 *
 * Split into a PURE core (`mapContinueRecords`) the tests drive with fixtures and
 * a filesystem wrapper (`collectContinue`) reusing the shared per-file cache.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "./shared.js";
import type { NativeCollectResult } from "./native/claude.js";
import { NATIVE_READ_BUDGET_MS } from "./native/claude.js";
import { nativeCachePath, readFilesWithCache } from "./native/file-cache.js";
import { localUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Normalize a Continue timestamp (ISO string, epoch-ms, or epoch-seconds) to
 * epoch milliseconds, or null when it's missing/unparseable.
 */
function toEpochMs(ts: unknown): number | null {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    if (ts <= 0) return null;
    // Heuristic: >= 1e12 is already milliseconds; a 10-digit value is seconds.
    return ts >= 1e12 ? ts : ts * 1000;
  }
  if (typeof ts === "string" && ts) {
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

interface Bucket {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  requestCount: number;
}

/**
 * PURE core: fold Continue `tokensGenerated` records into per-(date, model)
 * daily entries tagged tool "continue", one request each.
 */
export function mapContinueRecords(records: unknown[]): DailyUsageEntry[] {
  const byKey = new Map<string, Bucket>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    // dev_data holds one file per event type (tokensGenerated, autocomplete,
    // chatInteraction, …). Only `tokensGenerated` carries per-generation token
    // counts; guard on the event name (when present) so a sibling file's records
    // can never be miscounted. Legacy 0.1.0 records omit `eventName` → allowed.
    if (typeof rec.eventName === "string" && rec.eventName !== "tokensGenerated")
      continue;
    const model = typeof rec.model === "string" && rec.model ? rec.model : null;
    if (!model) continue;
    const ms = toEpochMs(rec.timestamp ?? rec.eventTimestamp);
    if (ms === null) continue;
    const date = localUsageDate(ms);
    if (!date) continue;
    const inputTokens = num(rec.promptTokens ?? rec.prompt_tokens);
    const outputTokens = num(rec.generatedTokens ?? rec.generated_tokens);
    if (inputTokens + outputTokens === 0) continue;

    const key = `${date}|${model}`;
    let b = byKey.get(key);
    if (!b) {
      b = { date, model, inputTokens: 0, outputTokens: 0, costUSD: 0, requestCount: 0 };
      byKey.set(key, b);
    }
    b.inputTokens += inputTokens;
    b.outputTokens += outputTokens;
    b.costUSD += estimateCostUSD(model, {
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    b.requestCount += 1;
  }

  const entries: DailyUsageEntry[] = [];
  for (const b of byKey.values()) {
    entries.push({
      date: b.date,
      tool: "continue",
      model: b.model,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: Number(b.costUSD.toFixed(6)),
      origin: "cli",
      verified: false,
      requestCount: b.requestCount,
    });
  }
  return entries;
}

/** Parse one dev_data `*.jsonl` body (one JSON object per line) into entries. */
export function parseContinueJsonl(content: string): DailyUsageEntry[] {
  const records: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt line
    }
  }
  return mapContinueRecords(records);
}

/** Recursively list every `*.jsonl` under a directory (best effort). */
async function listJsonl(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await listJsonl(full)));
    else if (d.isFile() && d.name === "tokensGenerated.jsonl") out.push(full);
  }
  return out;
}

/** Bump when the parse/aggregate semantics change — invalidates the per-file cache. */
export const CONTINUE_CACHE_VERSION = 2;

// Compact per-file cache row: [date, model, in, out, cost, requestCount].
type CachedRow = [string, string, number, number, number, number];

export interface CollectContinueOpts {
  /** Continue home dir (default `~/.continue`); the reader scans `<dir>/dev_data`. */
  continueDir?: string;
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  now?: () => number;
  cachePath?: string;
}

/**
 * Read Continue's `dev_data` JSONL and aggregate it. Best-effort and
 * time-bounded like the other native readers: `found:false` when there's no
 * `dev_data` dir (clean no-op), `timedOut:true` on a budget timeout rather than
 * submitting a partial corpus.
 */
export async function collectContinue(
  opts: CollectContinueOpts = {},
): Promise<NativeCollectResult> {
  const env = opts.env ?? process.env;
  const home = opts.continueDir ?? join(env.HOME || homedir(), ".continue");
  const files = await listJsonl(join(home, "dev_data"));
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const now = opts.now ?? Date.now;
  const res = await readFilesWithCache<CachedRow>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("continue", env),
    version: CONTINUE_CACHE_VERSION,
    parseFile: (content) =>
      parseContinueJsonl(content).map((e) => [
        e.date,
        e.model,
        e.inputTokens,
        e.outputTokens,
        e.costUSD,
        e.requestCount ?? 0,
      ]),
    deadline: now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS),
    now,
  });
  if (!res.itemsByFile) {
    return { entries: [], found: false, filesScanned: res.filesRead, timedOut: true };
  }

  // Merge rows across files, summing any that share (date, model). dev_data is
  // append-only, so files re-parse only when they grow — no double counting.
  const byKey = new Map<string, Bucket>();
  for (const rows of res.itemsByFile) {
    for (const r of rows) {
      const key = `${r[0]}|${r[1]}`;
      let b = byKey.get(key);
      if (!b) {
        b = { date: r[0], model: r[1], inputTokens: 0, outputTokens: 0, costUSD: 0, requestCount: 0 };
        byKey.set(key, b);
      }
      b.inputTokens += r[2];
      b.outputTokens += r[3];
      b.costUSD += r[4];
      b.requestCount += r[5];
    }
  }
  const entries: DailyUsageEntry[] = [...byKey.values()].map((b) => ({
    date: b.date,
    tool: "continue",
    model: b.model,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: Number(b.costUSD.toFixed(6)),
    origin: "cli",
    verified: false,
    requestCount: b.requestCount,
  }));
  return { entries, found: true, filesScanned: res.filesRead };
}
