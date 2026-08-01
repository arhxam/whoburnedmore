/**
 * Native Codex (OpenAI CLI) usage reader.
 *
 * Codex writes one "rollout" JSONL per session under
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<session-uuid>.jsonl`
 * (default `~/.codex`). Each line is `{timestamp, type, payload}`. Token usage is
 * reported by `event_msg` lines whose `payload.type === "token_count"`, and those
 * totals are CUMULATIVE for the session — every turn re-reports the running total
 * (older builds inline the fields; newer builds nest them under
 * `payload.info.total_token_usage`). So a session's true usage is the LAST
 * token_count event, never the sum of them (summing is the classic Codex
 * triple-count bug). The model comes from `turn_context` / `session_meta`.
 *
 * As with Claude, this is split into a PURE core the tests drive
 * (`parseCodexRollout`, `aggregateCodexSessions`) and a filesystem wrapper.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";
import { nativeCachePath, readFilesWithCache } from "./file-cache.js";
import { localUsageDate } from "./usage-date.js";

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Pull the cumulative token fields out of a token_count payload (both layouts). */
function readTokenFields(payload: Record<string, unknown>): {
  input: number;
  cached: number;
  output: number;
} | null {
  // Newer builds nest the running total under info.total_token_usage.
  const info = payload.info as Record<string, unknown> | undefined;
  const src =
    (info?.total_token_usage as Record<string, unknown> | undefined) ?? payload;
  const input = src.input_tokens;
  const output = src.output_tokens;
  if (input === undefined && output === undefined) return null;
  return {
    input: num(input),
    cached: num(src.cached_input_tokens),
    output: num(output),
  };
}

export interface CodexSession {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Number of token_count (turn) events — the structural fingerprint proxy. */
  turnCount: number;
}

/**
 * Parse one session's rollout lines into PER-DAY usage records (one per local
 * day the session was active), or an empty array if it reported no usage.
 *
 * Codex token_count events carry the session's RUNNING CUMULATIVE total (every
 * turn re-reports the running total, not a delta). A single rollout file can
 * span many calendar days, so attributing the whole cumulative to the last
 * event's day — as this once did — dumps a multi-day session's entire total onto
 * one day and massively inflates that day's board number. Instead we bucket each
 * token_count by its OWN local day, keep the last cumulative seen on each day,
 * and emit each day's INCREMENTAL usage (that day's ending cumulative minus the
 * previous active day's ending cumulative). Because the cumulative is monotonic,
 * those per-day deltas sum back to the session total with no double-counting.
 */
export function parseCodexRollout(lines: Iterable<string>): CodexSession[] {
  let model = "unknown";
  // Per local day: the LAST cumulative seen that day + turn count that day.
  // Insertion order follows the (chronological) event stream.
  const perDay = new Map<
    string,
    { cum: { input: number; cached: number; output: number }; turns: number }
  >();
  let lastSeenDate: string | null = null;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;

    // The line kind is on the OUTER `type` (session_meta / turn_context /
    // event_msg); only event_msg carries a payload.type sub-discriminator.
    const kind = obj.type;
    if (kind === "session_meta" || kind === "turn_context") {
      if (typeof payload.model === "string" && payload.model) model = payload.model;
    }
    if (payload.type === "token_count") {
      const fields = readTokenFields(payload);
      if (!fields) continue;
      // Attribute to the event's own day; if the timestamp is unparseable, carry
      // forward the most recent known day rather than dropping the usage.
      const parsed = localUsageDate(Date.parse(String(obj.timestamp ?? "")));
      const day: string | null = parsed ?? lastSeenDate;
      if (!day) continue;
      lastSeenDate = day;
      const e = perDay.get(day);
      if (e) {
        e.cum = fields; // latest cumulative on that day
        e.turns += 1;
      } else {
        perDay.set(day, { cum: fields, turns: 1 });
      }
    }
  }

  if (perDay.size === 0) return [];

  // Walk days oldest→newest and difference the cumulative to get each day's
  // own usage. Map Codex's cumulative fields onto our four-field schema:
  //  - cache read  = cached input portion
  //  - input       = uncached input (input_tokens already includes the cached part)
  //  - output      = output_tokens, which already INCLUDES reasoning output
  //  - cache create= Codex doesn't report a separate cache-write count
  const dates = [...perDay.keys()].sort();
  const out: CodexSession[] = [];
  let prev = { input: 0, cached: 0, output: 0 };
  for (const date of dates) {
    const { cum, turns } = perDay.get(date)!;
    // Per-day deltas (monotonic cumulative ⇒ non-negative; max(0) guards any reset).
    const dInput = Math.max(0, cum.input - prev.input);
    const dCached = Math.max(0, cum.cached - prev.cached);
    const dOutput = Math.max(0, cum.output - prev.output);
    prev = cum;
    const cacheReadTokens = dCached;
    const inputTokens = Math.max(0, dInput - dCached);
    const outputTokens = dOutput;
    if (inputTokens + outputTokens + cacheReadTokens === 0) continue; // idle day
    out.push({
      date,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      turnCount: turns,
    });
  }
  return out;
}

interface CodexBucket {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}
/** Running per-(date,model) accumulator across streamed sessions. */
export type CodexAccumulator = Map<string, CodexBucket>;

/** Fold already-parsed per-day session records into an accumulator. */
export function foldCodexSessions(
  acc: CodexAccumulator,
  sessions: Iterable<CodexSession>,
): void {
  for (const s of sessions) {
    const k = `${s.date}|${s.model}`;
    let b = acc.get(k);
    if (!b) {
      b = {
        date: s.date,
        model: s.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      };
      acc.set(k, b);
    }
    b.inputTokens += s.inputTokens;
    b.outputTokens += s.outputTokens;
    b.cacheCreationTokens += s.cacheCreationTokens;
    b.cacheReadTokens += s.cacheReadTokens;
    b.requestCount += s.turnCount;
  }
}

/** Parse one session's lines and fold its per-day records into an accumulator. */
export function accumulateCodexSession(
  acc: CodexAccumulator,
  lines: Iterable<string>,
): void {
  foldCodexSessions(acc, parseCodexRollout(lines));
}

/** Group a Codex accumulator into per-(date,model) daily entries. */
export function finalizeCodexEntries(acc: CodexAccumulator): DailyUsageEntry[] {
  const entries: DailyUsageEntry[] = [];
  for (const b of acc.values()) {
    entries.push({
      date: b.date,
      tool: "codex",
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
 * Aggregate many parsed sessions into per-(date, model) daily entries (one-shot
 * over accumulate + finalize, used by tests). `requestCount` = total turn events
 * across sessions in a bucket (a forged Codex day has zero real turns).
 */
export function aggregateCodexSessions(
  sessions: Array<Iterable<string>>,
): DailyUsageEntry[] {
  const acc: CodexAccumulator = new Map();
  for (const lines of sessions) accumulateCodexSession(acc, lines);
  return finalizeCodexEntries(acc);
}

/** Resolve the Codex sessions root (honors CODEX_HOME, default ~/.codex). */
export function resolveCodexSessionsDir(env = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : join(homedir(), ".codex");
  return resolve(home, "sessions");
}

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
    else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
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

export interface NativeCollectResult {
  entries: DailyUsageEntry[];
  found: boolean;
  filesScanned: number;
  timedOut?: boolean;
}

/** Wall-clock budget for the whole native Codex read (see claude.ts — with the
 *  per-file cache this effectively gates only the cold first pass). */
export const NATIVE_READ_BUDGET_MS = 45_000;

/** Bump when parse semantics change — invalidates the per-file cache. */
export const CODEX_CACHE_VERSION = 2;

/**
 * Compact per-file cache row: [date, model, in, out, cacheCreate, cacheRead,
 * turnCount] — one per active day of the session that file holds.
 */
type CachedSession = [string, string, number, number, number, number, number];

function toCachedSession(s: CodexSession): CachedSession {
  return [
    s.date,
    s.model,
    s.inputTokens,
    s.outputTokens,
    s.cacheCreationTokens,
    s.cacheReadTokens,
    s.turnCount,
  ];
}

function fromCachedSession(t: CachedSession): CodexSession {
  return {
    date: t[0],
    model: t[1],
    inputTokens: t[2],
    outputTokens: t[3],
    cacheCreationTokens: t[4],
    cacheReadTokens: t[5],
    turnCount: t[6],
  };
}

/**
 * Read every Codex rollout on disk and aggregate it. Best effort, memory-
 * bounded (one rollout at a time), and incremental via the persistent per-file
 * cache: a rollout is one session file whose per-day records fold additively,
 * so caching each file's parsed records is exactly equivalent to re-parsing it.
 * Unchanged (size, mtime) files are never re-read; on budget exhaustion the
 * progress persists and `found:false` keeps the abandon-to-ccusage semantics
 * (see claude.ts for the full rationale). `filesScanned` counts files actually
 * READ this run.
 */
export async function collectCodexNative(
  env = process.env,
  opts: { budgetMs?: number; now?: () => number; cachePath?: string } = {},
): Promise<NativeCollectResult> {
  const dir = resolveCodexSessionsDir(env);
  const files = await listJsonl(dir);
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };
  const now = opts.now ?? Date.now;
  const res = await readFilesWithCache<CachedSession>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("codex", env),
    version: CODEX_CACHE_VERSION,
    parseFile: (content) =>
      parseCodexRollout(splitLines(content)).map(toCachedSession),
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
  const acc: CodexAccumulator = new Map();
  for (const items of res.itemsByFile) {
    foldCodexSessions(acc, items.map(fromCachedSession));
  }
  return {
    entries: finalizeCodexEntries(acc),
    found: true,
    filesScanned: res.filesRead,
  };
}
