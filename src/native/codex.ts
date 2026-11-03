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
import { basename, join, resolve } from "node:path";
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
export interface CodexRolloutInspection {
  sessions: CodexSession[];
  /** Legacy file-local totals from a fork/subagent file; never publish directly. */
  replaySessions: CodexSession[];
  /** Local dates present in a fork/subagent file that requires replay deduplication. */
  replayCandidateDates: string[];
}

interface CodexUsageEvent {
  /** Epoch ms, or 0 when the line had no parseable timestamp. */
  ts: number;
  input: number;
  cached: number;
  output: number;
}

interface CodexExtract {
  model: string;
  replayed: boolean;
  events: CodexUsageEvent[];
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function extractCodexRollout(lines: Iterable<string>): CodexExtract {
  let model = "unknown";
  let sawSessionMeta = false;
  let replayed = false;
  const events: CodexUsageEvent[] = [];
  for (const raw of lines) {
    const trimmed = stripLeadingBom(raw).trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(stripLeadingBom(trimmed)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;

    const kind = obj.type;
    if (kind === "session_meta" && !sawSessionMeta) {
      sawSessionMeta = true;
      const source = payload.source as Record<string, unknown> | undefined;
      if (
        typeof payload.forked_from_id === "string" ||
        typeof payload.parent_thread_id === "string" ||
        (source && typeof source === "object" && source.subagent !== undefined)
      ) {
        replayed = true;
      }
    }
    if (kind === "session_meta" || kind === "turn_context") {
      if (typeof payload.model === "string" && payload.model) model = payload.model;
    }
    if (payload.type === "token_count") {
      const fields = readTokenFields(payload);
      if (!fields) continue;
      const ts = Date.parse(String(obj.timestamp ?? ""));
      events.push({
        ts: Number.isFinite(ts) ? ts : 0,
        input: fields.input,
        cached: fields.cached,
        output: fields.output,
      });
    }
  }
  return { model, replayed, events };
}

/** Assign local days at call time. A warm cache of raw events rebuckets after a TZ change. */
function bucketCodexEvents(extracted: CodexExtract): CodexRolloutInspection {
  const perDay = new Map<
    string,
    { cum: { input: number; cached: number; output: number }; turns: number }
  >();
  let lastSeenDate: string | null = null;
  for (const event of extracted.events) {
    const parsed = event.ts > 0 ? localUsageDate(event.ts) : null;
    const day: string | null = parsed ?? lastSeenDate;
    if (!day) continue;
    lastSeenDate = day;
    const cum = { input: event.input, cached: event.cached, output: event.output };
    const existing = perDay.get(day);
    if (existing) {
      existing.cum = cum;
      existing.turns += 1;
    } else {
      perDay.set(day, { cum, turns: 1 });
    }
  }
  if (perDay.size === 0) return { sessions: [], replaySessions: [], replayCandidateDates: [] };

  const dates = [...perDay.keys()].sort();
  const out: CodexSession[] = [];
  let prev = { input: 0, cached: 0, output: 0 };
  for (const date of dates) {
    const { cum, turns } = perDay.get(date)!;
    const dInput = Math.max(0, cum.input - prev.input);
    const dCached = Math.max(0, cum.cached - prev.cached);
    const dOutput = Math.max(0, cum.output - prev.output);
    prev = cum;
    const cacheReadTokens = Math.min(dCached, dInput);
    const inputTokens = dInput - cacheReadTokens;
    const outputTokens = dOutput;
    if (inputTokens + outputTokens + cacheReadTokens === 0) continue;
    out.push({
      date,
      model: extracted.model,
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      turnCount: turns,
    });
  }
  return {
    sessions: extracted.replayed ? [] : out,
    replaySessions: extracted.replayed ? out : [],
    replayCandidateDates: extracted.replayed ? dates : [],
  };
}

export function inspectCodexRollout(lines: Iterable<string>): CodexRolloutInspection {
  return bucketCodexEvents(extractCodexRollout(lines));
}

export function parseCodexRollout(lines: Iterable<string>): CodexSession[] {
  return inspectCodexRollout(lines).sessions;
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

/** Resolve the Codex home (honors CODEX_HOME, default ~/.codex). */
function resolveCodexHome(env = process.env): string {
  return env.CODEX_HOME && env.CODEX_HOME.trim()
    ? env.CODEX_HOME.trim()
    : join(homedir(), ".codex");
}

/** Resolve the live Codex sessions root (compatibility helper for watchers). */
export function resolveCodexSessionsDir(env = process.env): string {
  return resolve(resolveCodexHome(env), "sessions");
}

/**
 * Every root holding Codex rollouts. Codex moves finished sessions out of
 * `sessions/` to `archived_sessions/`, so both roots are required for complete
 * history. The live root is first and wins if a move temporarily leaves the
 * same rollout in both places. Archives flatten the date directories, so the
 * rollout filename (which contains the session UUID) is the stable identity.
 */
export function resolveCodexSessionsDirs(env = process.env): string[] {
  const home = resolve(resolveCodexHome(env));
  return [join(home, "sessions"), join(home, "archived_sessions")];
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
  replayCandidateDates?: string[];
  /** Exact native/file-local scope a legacy CLI would have submitted. */
  legacyEntries?: DailyUsageEntry[];
}

/** Wall-clock budget for the whole native Codex read (see claude.ts — with the
 *  per-file cache this effectively gates only the cold first pass). */
export const NATIVE_READ_BUDGET_MS = 45_000;

/** Bump when parse semantics change — invalidates the per-file cache. */
export const CODEX_CACHE_VERSION = 8;

/**
 * Compact per-file cache row: [kind, timestamp, model, cumInput, cumCached, cumOutput].
 * Days are assigned when the row is read, not when it is cached.
 */
type CachedEvent = [
  "usage" | "duplicate" | "replay" | "replay-duplicate",
  number,
  string,
  number,
  number,
  number,
];

function eventsFromCache(items: CachedEvent[]): CodexExtract {
  return {
    model: items[0]?.[2] || "unknown",
    replayed: items[0]?.[0] === "replay" || items[0]?.[0] === "replay-duplicate",
    events: items.map((row) => ({
      ts: row[1],
      input: row[3],
      cached: row[4],
      output: row[5],
    })),
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
  opts: { budgetMs?: number; now?: () => number; cachePath?: string; maxFileBytes?: number } = {},
): Promise<NativeCollectResult> {
  const dirs = resolveCodexSessionsDirs(env);
  // Read every physical file so `legacyEntries` can reconstruct the exact old
  // native scope, including a rollout duplicated between live and archive.
  // Mark only the first path for each rollout basename as publishable so the
  // diagnostic `entries` retain the new overlap-deduplicated semantics.
  const files: string[] = [];
  const primaryFiles = new Set<string>();
  const seenIdentities = new Set<string>();
  for (const dir of dirs) {
    for (const file of await listJsonl(dir)) {
      const key = basename(file);
      files.push(file);
      if (!seenIdentities.has(key)) {
        seenIdentities.add(key);
        primaryFiles.add(file);
      }
    }
  }
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };
  const now = opts.now ?? Date.now;
  const res = await readFilesWithCache<CachedEvent>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("codex", env),
    version: CODEX_CACHE_VERSION,
    parseFile: (content, path) => {
      const extracted = extractCodexRollout(splitLines(content));
      const primary = primaryFiles.has(path);
      const kind: CachedEvent[0] = extracted.replayed
        ? primary
          ? "replay"
          : "replay-duplicate"
        : primary
          ? "usage"
          : "duplicate";
      return extracted.events.map(
        (event): CachedEvent => [
          kind,
          event.ts,
          extracted.model,
          event.input,
          event.cached,
          event.output,
        ],
      );
    },
    deadline: now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS),
    now,
    maxFileBytes: opts.maxFileBytes,
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
  const legacyAcc: CodexAccumulator = new Map();
  const replayCandidateDates = new Set<string>();
  for (const items of res.itemsByFile) {
    if (items.length === 0) continue;
    const kind = items[0][0];
    const inspection = bucketCodexEvents(eventsFromCache(items));
    const records = [...inspection.sessions, ...inspection.replaySessions];
    if (kind === "usage") foldCodexSessions(acc, inspection.sessions);
    foldCodexSessions(legacyAcc, records);
    if (kind === "replay" || kind === "replay-duplicate") {
      for (const date of inspection.replayCandidateDates) replayCandidateDates.add(date);
    }
  }
  return {
    entries: finalizeCodexEntries(acc),
    found: true,
    filesScanned: res.filesRead,
    replayCandidateDates: [...replayCandidateDates].sort(),
    legacyEntries: finalizeCodexEntries(legacyAcc),
  };
}
