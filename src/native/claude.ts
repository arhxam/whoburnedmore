/**
 * Native Claude Code usage reader.
 *
 * Why this exists: we used to depend entirely on the third-party `ccusage`
 * binary to read Claude Code's local logs, but it has confirmed miscount bugs —
 * it both OVER-counts (re-counting forked/duplicated sessions) and UNDER-counts
 * (its keep-FIRST dedup drops the final token value of a streamed message,
 * ccusage#888). On this maintainer's own machine the raw transcript sum was
 * 1.3-5.9x ccusage's number on recent days. So we parse the raw transcripts
 * ourselves with the correct dedup rule and, crucially, emit a structural
 * fingerprint (the count of DISTINCT provider requests) that the server uses as
 * an anti-fraud signal.
 *
 * Claude Code writes append-only JSON Lines to
 * `<configDir>/projects/<slug>/<session-uuid>.jsonl`. Each assistant turn is one
 * logical request identified by `message.id` (msg_...) + top-level `requestId`
 * (req_...). While a response streams, Claude Code writes several intermediate
 * lines that SHARE that id pair but carry placeholder/partial token values; the
 * final line carries the real totals. The correct aggregation therefore dedups
 * by (message.id, requestId) keeping the MAXIMAL token entry — never the first
 * (undercount) and never the sum of all of them (overcount).
 *
 * This module is split into a PURE core (`aggregateClaudeLines`) that the unit
 * tests drive with fixtures, and a thin filesystem wrapper (`collectClaudeNative`).
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";
import {
  MAX_NATIVE_FILE_BYTES,
  nativeCachePath,
  readFilesWithCache,
  readTextFileCapped,
} from "./file-cache.js";
import { localUsageDate } from "./usage-date.js";

/** One deduped provider request extracted from a transcript line. */
export interface ParsedRequest {
  /** Stable identity for a single provider request (msg id + req id). */
  key: string;
  /** True when the key is backed by a real provider id (not a synthetic one). */
  hasRealId: boolean;
  /** Local-calendar date (YYYY-MM-DD), matching ccusage's local-tz bucketing. */
  date: string;
  /** Epoch milliseconds of this line's timestamp (0 if unparseable). Used by the
   *  `verify` skeleton for the physical-throughput forensic check. */
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Total of the four token fields. */
function reqTokens(r: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return (
    r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens
  );
}

/**
 * Convert an ISO timestamp to a local YYYY-MM-DD. ccusage buckets days in the
 * user's local timezone, and the rest of our pipeline (leaderboard, anti-cheat
 * future-date skew) already assumes local dates, so we match that here.
 */
let syntheticCounter = 0;

/**
 * Parse one transcript line into a request, or null if it carries no usage.
 * Counts assistant messages that have a `message.usage` object — including
 * subagent sidechain lines, which consume real tokens and must be counted.
 */
export function parseClaudeLine(raw: string): ParsedRequest | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  // Only assistant turns carry billable usage; user/summary lines never do, but
  // guard anyway in case a non-assistant line ever sprouts a usage stub.
  if (message.role !== undefined && message.role !== "assistant") return null;

  const tsParsed = Date.parse(String(obj.timestamp ?? ""));
  const date = localUsageDate(tsParsed);
  if (!date) return null;
  const ts = tsParsed;

  const messageId = typeof message.id === "string" ? message.id : "";
  const requestId = typeof obj.requestId === "string" ? obj.requestId : "";
  const hasRealId = messageId !== "" || requestId !== "";
  // No provider ids at all (shouldn't happen for assistant turns) — give the
  // line its own synthetic key so it is always counted, never merged away.
  const key = hasRealId
    ? `${messageId}|${requestId}`
    : `synthetic|${date}|${(syntheticCounter += 1)}`;

  return {
    key,
    hasRealId,
    date,
    ts,
    model: typeof message.model === "string" ? message.model : "unknown",
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}

/** The running dedup state: the maximal-token request per (message.id,requestId). */
export type ClaudeAccumulator = Map<string, ParsedRequest>;

/**
 * Fold a batch of transcript lines into an EXISTING accumulator. Dedup rule:
 * group by (message.id, requestId) and keep the MAXIMAL-token occurrence — this
 * collapses streamed intermediate lines (partial counts) to the one true final
 * count, fixing both the undercount (keep-first) and overcount (sum-of-all)
 * modes. Streaming files through one shared accumulator keeps peak memory at the
 * size of the deduped request set (bounded by the number of real requests), NOT
 * the whole on-disk corpus — the 852MB-resident OOM trap of reading every file
 * first.
 */
export function accumulateClaudeLines(
  acc: ClaudeAccumulator,
  lines: Iterable<string>,
): void {
  for (const line of lines) {
    const r = parseClaudeLine(line);
    if (!r) continue;
    const prev = acc.get(r.key);
    if (!prev || reqTokens(r) > reqTokens(prev)) acc.set(r.key, r);
  }
}

/** Group a deduped accumulator into per-(date, model) daily entries. */
export function finalizeClaudeEntries(acc: ClaudeAccumulator): DailyUsageEntry[] {
  interface Bucket {
    date: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    requestCount: number;
  }
  const byDayModel = new Map<string, Bucket>();
  for (const r of acc.values()) {
    const k = `${r.date}|${r.model}`;
    let b = byDayModel.get(k);
    if (!b) {
      b = {
        date: r.date,
        model: r.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      };
      byDayModel.set(k, b);
    }
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cacheCreationTokens += r.cacheCreationTokens;
    b.cacheReadTokens += r.cacheReadTokens;
    // Only real provider ids count toward the fingerprint — a synthetic-keyed
    // line (no ids) is NOT evidence of a real request.
    if (r.hasRealId) b.requestCount += 1;
  }

  const entries: DailyUsageEntry[] = [];
  for (const b of byDayModel.values()) {
    const tokens =
      b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens;
    if (tokens === 0) continue;
    entries.push({
      date: b.date,
      tool: "claude",
      model: b.model,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationTokens: b.cacheCreationTokens,
      cacheReadTokens: b.cacheReadTokens,
      costUSD: estimateCostUSD(b.model, b),
      origin: "cli",
      verified: false,
      requestCount: b.requestCount,
    });
  }
  return entries;
}

/**
 * Aggregate raw transcript lines into per-(date, model) daily entries (the
 * one-shot, all-in-memory convenience over `accumulateClaudeLines` +
 * `finalizeClaudeEntries`, used by tests and the offline measurement script).
 */
export function aggregateClaudeLines(
  lines: Iterable<string>,
): DailyUsageEntry[] {
  const acc: ClaudeAccumulator = new Map();
  accumulateClaudeLines(acc, lines);
  return finalizeClaudeEntries(acc);
}

/**
 * Resolve the Claude Code config directories to scan. Honors `CLAUDE_CONFIG_DIR`
 * (a single dir or comma-separated list — the same override ccusage respects);
 * otherwise scans BOTH `~/.claude` and `~/.config/claude`, since Claude Code
 * migrated toward the XDG location and a user's data can live in either (a real
 * ccusage failure mode is scanning only one). Returns the `<dir>/projects` roots.
 */
export function resolveClaudeConfigRoots(env = process.env): string[] {
  const override = env.CLAUDE_CONFIG_DIR;
  return override
    ? override
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [join(homedir(), ".claude"), join(homedir(), ".config", "claude")];
}

export function resolveClaudeProjectDirs(env = process.env): string[] {
  return resolveClaudeConfigRoots(env).map((r) => join(r, "projects"));
}

/** Recursively list every `*.jsonl` file under a directory (best effort). */
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
    if (d.isDirectory()) {
      out.push(...(await listJsonl(full)));
    } else if (d.isFile() && d.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

export interface NativeCollectResult {
  entries: DailyUsageEntry[];
  /** True when at least one transcript file was found (whether or not it had usage). */
  found: boolean;
  filesScanned: number;
  /** True when the read abandoned early on its time budget (caller should fall back). */
  timedOut?: boolean;
}

/**
 * Wall-clock budget for the whole native Claude read. With the persistent
 * per-file cache a steady-state run only reads the files that changed since the
 * last run (seconds even under launchd Background throttling), so this budget
 * effectively gates only the COLD first pass over a big corpus. It was 20s,
 * which a multi-GB corpus chronically blew on every 15-minute background tick —
 * the source then silently dropped out of the payload run after run and heavy
 * users' day-rows were born hours late (the daily-board "missing people" bug).
 * 45s makes a one-shot cold build succeed on most machines; a corpus too big
 * even for that still converges, because progress persists across ticks.
 */
export const NATIVE_READ_BUDGET_MS = 45_000;

/** Bump when parse/dedup semantics change — invalidates the per-file cache. */
export const CLAUDE_CACHE_VERSION = 2;

/**
 * Compact per-file cache row: [key, hasRealId, date, model, in, out, cacheCreate,
 * cacheRead]. Tuples (not objects) keep the on-disk cache several times smaller.
 */
type CachedRequest = [string, 0 | 1, string, string, number, number, number, number];

function toCached(r: ParsedRequest): CachedRequest {
  return [
    r.key,
    r.hasRealId ? 1 : 0,
    r.date,
    r.model,
    r.inputTokens,
    r.outputTokens,
    r.cacheCreationTokens,
    r.cacheReadTokens,
  ];
}

function fromCached(t: CachedRequest): ParsedRequest {
  return {
    key: t[0],
    hasRealId: t[1] === 1,
    date: t[2],
    ts: 0,
    model: t[3],
    inputTokens: t[4],
    outputTokens: t[5],
    cacheCreationTokens: t[6],
    cacheReadTokens: t[7],
  };
}

/**
 * Parse ONE file's lines into its deduped request rows for the cache. Synthetic
 * keys (lines with no provider ids) are re-minted as file-scoped ids: the
 * module-level counter restarts every process, so cached synthetic keys from a
 * previous run would collide with a new run's and be wrongly merged by the
 * cross-file max-wins dedup. `<path>` is unique per file and the index is
 * deterministic per parse, so these keys never collide and (like the original
 * global counter) never dedup across files.
 */
function parseFileToCache(content: string, path: string): CachedRequest[] {
  const acc: ClaudeAccumulator = new Map();
  accumulateClaudeLines(acc, splitLines(content));
  let synIndex = 0;
  return [...acc.values()].map((r) =>
    toCached(
      r.hasRealId ? r : { ...r, key: `synthetic|${path}|${(synIndex += 1)}` },
    ),
  );
}

function* splitLines(content: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      yield content.slice(start, i);
      start = i + 1;
    }
  }
  if (start < content.length) yield content.slice(start);
}

/**
 * Read every Claude Code transcript on disk and aggregate it. Best effort: an
 * unreadable file is skipped, and a missing config dir yields `found:false` so
 * the caller can fall back to ccusage.
 *
 * Incremental via the persistent per-file cache: transcripts are append-only,
 * so files whose (size, mtime) are unchanged reuse their cached parse and only
 * new/changed files are read — steady state is "today's active sessions", not
 * the whole corpus. The wall-clock budget therefore effectively gates only the
 * cold first pass; on timeout, progress is PERSISTED (a later run resumes and
 * completes) and `found:false` keeps the abandon-to-ccusage semantics — a
 * partial corpus is never submitted (recent days would be overwritten with an
 * undercount). Cross-file fork dedup is preserved because per-file rows are
 * merged max-wins by (message.id, requestId) exactly as the uncached read did.
 * `filesScanned` now counts files actually READ this run (cache hits are free).
 */
export async function collectClaudeNative(
  env = process.env,
  opts: { budgetMs?: number; now?: () => number; cachePath?: string } = {},
): Promise<NativeCollectResult> {
  const dirs = resolveClaudeProjectDirs(env);
  const files: string[] = [];
  for (const dir of dirs) files.push(...(await listJsonl(dir)));
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const now = opts.now ?? Date.now;
  const res = await readFilesWithCache<CachedRequest>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("claude", env),
    version: CLAUDE_CACHE_VERSION,
    parseFile: parseFileToCache,
    deadline: now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS),
    now,
  });
  if (!res.itemsByFile) {
    return {
      entries: [],
      found: false,
      filesScanned: res.filesRead,
      timedOut: true,
    };
  }
  // Cross-file dedup: forked/duplicated sessions repeat (message.id, requestId)
  // pairs across files; keep the maximal-token occurrence, same as before.
  const acc: ClaudeAccumulator = new Map();
  for (const items of res.itemsByFile) {
    for (const t of items) {
      const r = fromCached(t);
      const prev = acc.get(r.key);
      if (!prev || reqTokens(r) > reqTokens(prev)) acc.set(r.key, r);
    }
  }
  return {
    entries: finalizeClaudeEntries(acc),
    found: true,
    filesScanned: res.filesRead,
  };
}

/**
 * Per-request skeleton for `whoburnedmore verify`: the DEDUPED provider requests
 * (each carrying its timestamp), NOT aggregated to daily. Reuses the exact same
 * read + dedup as `collectClaudeNative` — so the totals line up with what was
 * submitted — but returns one record per distinct request so the server can run
 * its forensic checks (internal consistency, physical throughput, request
 * density). Still content-free: only token counts, model, timestamp, and the
 * (message-id, request-id) key. Best-effort, time-bounded like the aggregate read.
 */
export async function collectClaudeRequests(
  env = process.env,
  opts: { budgetMs?: number; now?: () => number; maxFileBytes?: number } = {},
): Promise<{ requests: ParsedRequest[]; found: boolean; timedOut?: boolean }> {
  const dirs = resolveClaudeProjectDirs(env);
  const files: string[] = [];
  for (const dir of dirs) files.push(...(await listJsonl(dir)));
  if (files.length === 0) return { requests: [], found: false };

  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const acc: ClaudeAccumulator = new Map();
  for (const f of files) {
    if (now() > deadline) {
      return { requests: [...acc.values()], found: true, timedOut: true };
    }
    const read = await readTextFileCapped(f, {
      maxBytes: opts.maxFileBytes ?? MAX_NATIVE_FILE_BYTES,
      deadline,
      now,
    });
    if (!read.ok) {
      if (read.reason === "timed-out") {
        return { requests: [...acc.values()], found: true, timedOut: true };
      }
      continue;
    }
    accumulateClaudeLines(acc, splitLines(read.content));
  }
  return { requests: [...acc.values()], found: true };
}
