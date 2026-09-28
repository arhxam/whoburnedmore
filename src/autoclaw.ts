/**
 * Native usage reader for AutoClaw — Z.ai's desktop AI agent (autoclaw.z.ai,
 * shipped by AutoGLM). The same lineage as upstream OpenClaw: the desktop app
 * runs the OpenClaw gateway runtime locally, so its agent transcripts are the
 * OpenClaw session JSONL layout. `ccusage` has no AutoClaw source, so we parse
 * those transcripts ourselves.
 *
 * Where the data lives (verified against an installed AutoClaw 1.18.5, macOS):
 * AutoClaw runs the gateway with a per-app state dir `~/.openclaw-autoclaw`
 * (upstream OpenClaw uses `~/.openclaw`; the `-autoclaw` suffix is the profile
 * the desktop app launches, and its agents live under `<root>/agents/<agentId>/`).
 * Each agent keeps its conversations in
 * `<root>/agents/<agentId>/sessions/<sessionId>.jsonl` — append-only JSONL, one
 * line per event. We read only those transcripts; the sibling sidecars are
 * deliberately NOT read:
 *   - `<sessionId>.trajectory.jsonl` — the trace schema (`session.started`,
 *     `model.completed`, …) carries NO usage block, so reading it would add
 *     nothing while doubling the bytes scanned;
 *   - `<sessionId>.trajectory-path.json` / `.jsonl.lock` — pointers and locks.
 *
 * A billable turn is a `type:"message"` line whose `message.role` is
 * `"assistant"` and which carries a `message.usage` object:
 *
 *   { "type":"message", "id":"916258b3", "parentId":"83bd2f01",
 *     "timestamp":"2026-09-28T05:52:51.005Z",
 *     "message": { "role":"assistant", "provider":"zai",
 *       "model":"tdpsk_deepseek-v4-flash-202605",
 *       "usage": { "input":13933, "output":137, "cacheRead":8576, "cacheWrite":0,
 *                  "reasoningTokens":12, "totalTokens":22646,
 *                  "cost":{ "input":0, "output":0, "cacheRead":0, "cacheWrite":0, "total":0 } } } }
 *
 * Note the field names differ from Claude Code's snake_case: `input`/`output`
 * (not `input_tokens`) and `cacheRead`/`cacheWrite` (not `cache_read_input_tokens`).
 * `reasoningTokens` are a SUBSET of `output` (they are the thinking part of the
 * completion), so they are never added — summing them would double-count.
 *
 * Dedup rule mirrors the Claude reader: a line's stable identity is
 * `<sessionId>|<line id>`, and when the same id appears more than once we keep
 * the MAXIMAL-token occurrence. That collapses any partially-written line to
 * the final true totals instead of both under-counting (keep-first) and
 * over-counting (sum-of-all). A forked/copied session file replays the same ids
 * under the same sessionId, so the cross-file merge dedups those too.
 *
 * Cost: AutoClaw meters on a GLM/DeepSeek credit subscription, so the recorded
 * `usage.cost.total` is 0 on every turn (confirmed in real transcripts). We
 * therefore estimate from the model, and only trust a recorded cost when the
 * app actually wrote one (a BYO-API-key install does).
 *
 * Purely additive and best-effort: with no AutoClaw state dir the reader returns
 * `found:false` and nothing else in the pipeline changes.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DailyUsageEntry } from "./shared.js";
import type { NativeCollectResult } from "./native/claude.js";
import { NATIVE_READ_BUDGET_MS } from "./native/claude.js";
import { nativeCachePath, readFilesWithCache } from "./native/file-cache.js";
import { localUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";

/** The `tool` id this reader publishes (what lands on the leaderboard). */
export const AUTOCLAW_TOOL = "autoclaw";

/** One deduped provider request extracted from an AutoClaw session line. */
export interface ParsedAutoclawRequest {
  /** Stable identity for one provider request: `<sessionId>|<line id>`. */
  key: string;
  /** True when the key is backed by a real transcript id, not a synthetic one. */
  hasRealId: boolean;
  /** Local-calendar date (YYYY-MM-DD), matching the rest of the pipeline. */
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** USD AutoClaw itself recorded for the turn, or null to fall back to estimation. */
  storedCost: number | null;
}

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Read one token bucket, tolerating the snake_case spelling an OpenAI-shaped
 * provider payload would carry. The gateway normalizes to the camelCase names
 * above, but this is a third-party on-disk contract that a future app release
 * may reshape, and a renamed bucket must read as zero rather than silently
 * under-count the whole run.
 */
function tokens(usage: Record<string, unknown>, camel: string, snake: string): number {
  return num(usage[camel] ?? usage[snake]);
}

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
 * Parse one session line into a request, or null when it carries no usage.
 * `sessionId` scopes the dedup key so two agents that happen to reuse a line
 * id never merge.
 */
export function parseAutoclawLine(
  raw: string,
  sessionId: string,
): ParsedAutoclawRequest | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== "message") return null;
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  // Only assistant turns are billable; user/toolResult lines never carry usage,
  // but guard so a future non-assistant stub can never be miscounted.
  if (message.role !== "assistant") return null;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;

  // `timestamp` is an ISO string on the envelope and epoch-ms inside the
  // message; prefer the envelope, fall back to the message field.
  const envelope = Date.parse(String(obj.timestamp ?? ""));
  const inner = Number(message.timestamp);
  const ms = Number.isFinite(envelope) ? envelope : inner;
  const date = localUsageDate(ms);
  if (!date) return null;

  const inputTokens = tokens(usage, "input", "input_tokens");
  const outputTokens = tokens(usage, "output", "output_tokens");
  const cacheCreationTokens = tokens(usage, "cacheWrite", "cache_creation_input_tokens");
  const cacheReadTokens = tokens(usage, "cacheRead", "cache_read_input_tokens");
  if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0) {
    return null;
  }

  const lineId = typeof obj.id === "string" && obj.id ? obj.id : "";
  const hasRealId = lineId !== "";
  const responseId =
    typeof message.responseId === "string" && message.responseId
      ? message.responseId
      : "";
  // A real line id is the request identity. `responseId` (the provider's own
  // response handle) backs it up when a transcript rewrite dropped the id, and
  // a line with neither gets its own synthetic key so it is counted once rather
  // than merged away.
  const key = lineId
    ? `${sessionId}|${lineId}`
    : responseId
      ? `${sessionId}|response:${responseId}`
      : `synthetic|${sessionId}|${(syntheticCounter += 1)}`;

  const cost = usage.cost as Record<string, unknown> | undefined;
  const storedCostRaw = Number(cost?.total);
  const model =
    typeof message.model === "string" && message.model
      ? message.model
      : AUTOCLAW_TOOL;

  return {
    key,
    hasRealId: hasRealId || responseId !== "",
    date,
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    storedCost:
      Number.isFinite(storedCostRaw) && storedCostRaw > 0 ? storedCostRaw : null,
  };
}

/** Module-scoped counter for id-less lines; see `parseAutoclawLine`. */
let syntheticCounter = 0;

/** The running dedup state: the maximal-token request per `<sessionId>|<id>`. */
export type AutoclawAccumulator = Map<string, ParsedAutoclawRequest>;

/**
 * Fold a batch of session lines into an EXISTING accumulator, keeping the
 * maximal-token occurrence per request key. Streaming files through one shared
 * accumulator keeps peak memory at the size of the deduped request set (bounded
 * by the number of real requests), NOT the whole on-disk corpus.
 */
export function accumulateAutoclawLines(
  acc: AutoclawAccumulator,
  sessionId: string,
  lines: Iterable<string>,
): void {
  for (const line of lines) {
    const r = parseAutoclawLine(line, sessionId);
    if (!r) continue;
    const prev = acc.get(r.key);
    if (!prev || reqTokens(r) > reqTokens(prev)) acc.set(r.key, r);
  }
}

interface Bucket {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  requestCount: number;
}

function newBucket(date: string, model: string): Bucket {
  return {
    date,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    requestCount: 0,
  };
}

function bucketsToEntries(buckets: Iterable<Bucket>): DailyUsageEntry[] {
  const entries: DailyUsageEntry[] = [];
  for (const b of buckets) {
    if (
      b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens ===
      0
    ) {
      continue;
    }
    entries.push({
      date: b.date,
      tool: AUTOCLAW_TOOL,
      model: b.model,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationTokens: b.cacheCreationTokens,
      cacheReadTokens: b.cacheReadTokens,
      costUSD: Number(b.costUSD.toFixed(6)),
      origin: "cli",
      verified: false,
      requestCount: b.requestCount,
    });
  }
  return entries;
}

/** Group a deduped accumulator into per-(date, model) daily entries. */
export function finalizeAutoclawEntries(
  acc: AutoclawAccumulator,
): DailyUsageEntry[] {
  const byDayModel = new Map<string, Bucket>();
  for (const r of acc.values()) {
    const k = `${r.date}|${r.model}`;
    let b = byDayModel.get(k);
    if (!b) {
      b = newBucket(r.date, r.model);
      byDayModel.set(k, b);
    }
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cacheCreationTokens += r.cacheCreationTokens;
    b.cacheReadTokens += r.cacheReadTokens;
    b.costUSD +=
      r.storedCost ??
      estimateCostUSD(r.model, {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cacheReadTokens: r.cacheReadTokens,
      });
    // Only rows backed by a real transcript/provider id count toward the
    // fingerprint — a synthetic-keyed line is not evidence of a real request.
    if (r.hasRealId) b.requestCount += 1;
  }
  return bucketsToEntries(byDayModel.values());
}

/**
 * Aggregate raw session lines into per-(date, model) daily entries (the
 * one-shot, all-in-memory convenience over `accumulateAutoclawLines` +
 * `finalizeAutoclawEntries`, used by tests and offline measurement).
 */
export function aggregateAutoclawLines(
  lines: Iterable<string>,
  sessionId = "session",
): DailyUsageEntry[] {
  const acc: AutoclawAccumulator = new Map();
  accumulateAutoclawLines(acc, sessionId, lines);
  return finalizeAutoclawEntries(acc);
}

/**
 * The AutoClaw state roots to scan. AutoClaw itself always uses the
 * `~/.openclaw-autoclaw` profile dir; the env overrides exist so a non-default
 * (portable/VPS) install is still counted. `OPENCLAW_*` is honored too because
 * AutoClaw ships the OpenClaw runtime and a power user may point the gateway
 * somewhere else.
 */
export function autoclawRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const override =
    env.AUTOCLAW_STATE_DIR?.trim() ||
    env.AUTOCLAW_HOME?.trim() ||
    env.OPENCLAW_STATE_DIR?.trim() ||
    env.OPENCLAW_CONFIG_DIR?.trim();
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  return [join(env.HOME || homedir(), ".openclaw-autoclaw")];
}

/** Session id of a transcript path: `<sessionId>.jsonl` → `<sessionId>`. */
export function autoclawSessionId(file: string): string {
  return basename(file).replace(/\.jsonl$/, "");
}

/**
 * Is this a conversation transcript we should read? The sidecars are excluded
 * by name (`*.trajectory.jsonl` is the no-usage trace schema) and by suffix
 * (`.trajectory-path.json`, `.jsonl.lock` don't end in `.jsonl`).
 */
function isTranscriptFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl");
}

/** Iteratively list `<root>/agents/<agentId>/sessions/*.jsonl` with work caps. */
async function listSessionFiles(
  roots: string[],
  opts: { deadline: number; now: () => number; maxAgents: number; maxFiles: number },
): Promise<{ files: string[]; aborted: boolean }> {
  const files: string[] = [];
  let agents = 0;
  for (const root of roots) {
    const agentsDir = join(root, "agents");
    let agentDirs: string[];
    try {
      const dirents = await readdir(agentsDir, { withFileTypes: true });
      agentDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue; // root absent (AutoClaw not installed here) — skip
    }
    for (const agent of agentDirs) {
      if (agents >= opts.maxAgents) {
        return { files: [], aborted: true };
      }
      agents += 1;
      const sessionsDir = join(agentsDir, agent, "sessions");
      let entries;
      try {
        entries = await readdir(sessionsDir, { withFileTypes: true });
      } catch {
        continue; // agent has no sessions dir yet
      }
      for (const e of entries) {
        if (!e.isFile() || !isTranscriptFile(e.name)) continue;
        files.push(join(sessionsDir, e.name));
        if (files.length > opts.maxFiles) return { files: [], aborted: true };
      }
      if (opts.now() > opts.deadline) return { files: [], aborted: true };
    }
  }
  return { files, aborted: false };
}

/** Bump when the parse/aggregate semantics change — invalidates the per-file cache. */
export const AUTOCLAW_CACHE_VERSION = 1;

/**
 * Compact per-file cache row: [key, hasRealId, date, model, in, out, cacheCreate,
 * cacheRead, storedCost]. Tuples keep the on-disk cache small.
 */
type CachedRow = [
  string,
  0 | 1,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
];

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
 * Parse ONE file's lines into its deduped request rows for the cache. Synthetic
 * keys are re-minted file-scoped: the module-level counter restarts every
 * process, so cached synthetic keys from a previous run would collide with a
 * new run's and be wrongly merged by the max-wins dedup.
 */
function parseFileToCache(content: string, path: string): CachedRow[] {
  const sessionId = autoclawSessionId(path);
  const acc: AutoclawAccumulator = new Map();
  accumulateAutoclawLines(acc, sessionId, splitLines(content));
  let synIndex = 0;
  return [...acc.values()].map((r) => [
    r.hasRealId ? r.key : `synthetic|${path}|${(synIndex += 1)}`,
    r.hasRealId ? 1 : 0,
    r.date,
    r.model,
    r.inputTokens,
    r.outputTokens,
    r.cacheCreationTokens,
    r.cacheReadTokens,
    r.storedCost ?? 0,
  ]);
}

export interface CollectAutoclawOpts {
  env?: NodeJS.ProcessEnv;
  /** Override the state roots (default: `autoclawRoots(env)`). */
  roots?: string[];
  budgetMs?: number;
  now?: () => number;
  cachePath?: string;
  maxAgents?: number;
  maxFiles?: number;
}

/**
 * Read every AutoClaw session transcript on disk and aggregate it. Best-effort
 * and time-bounded like the other native readers: a missing state dir yields
 * `found:false` (clean no-op), unreadable files are skipped, and on a budget
 * timeout it bows out with `timedOut:true` rather than submitting a partial
 * corpus (a partial scan would $set recent days to an undercount server-side).
 *
 * Incremental via the shared per-file cache: transcripts are append-only, so
 * files whose (size, mtime) are unchanged reuse their cached parse and only
 * new/changed files are read — steady state is "today's active sessions".
 */
export async function collectAutoclaw(
  opts: CollectAutoclawOpts = {},
): Promise<NativeCollectResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const discovery = await listSessionFiles(opts.roots ?? autoclawRoots(env), {
    deadline,
    now,
    maxAgents: Math.max(1, opts.maxAgents ?? 64),
    maxFiles: Math.max(1, opts.maxFiles ?? 20_000),
  });
  if (discovery.aborted) {
    return { entries: [], found: false, filesScanned: 0, timedOut: true };
  }
  const files = discovery.files;
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const res = await readFilesWithCache<CachedRow>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("autoclaw", env),
    version: AUTOCLAW_CACHE_VERSION,
    parseFile: parseFileToCache,
    deadline,
    now,
  });
  if (!res.itemsByFile) {
    return { entries: [], found: false, filesScanned: res.filesRead, timedOut: true };
  }

  // Cross-file dedup: a forked/copied session replays the same request ids
  // under the same session id, so merge max-wins exactly as the uncached read.
  const acc: AutoclawAccumulator = new Map();
  for (const rows of res.itemsByFile) {
    for (const r of rows) {
      const request: ParsedAutoclawRequest = {
        key: r[0],
        hasRealId: r[1] === 1,
        date: r[2],
        model: r[3],
        inputTokens: r[4],
        outputTokens: r[5],
        cacheCreationTokens: r[6],
        cacheReadTokens: r[7],
        storedCost: r[8] > 0 ? r[8] : null,
      };
      const prev = acc.get(request.key);
      if (!prev || reqTokens(request) > reqTokens(prev)) acc.set(request.key, request);
    }
  }
  return {
    entries: finalizeAutoclawEntries(acc),
    found: true,
    filesScanned: res.filesRead,
  };
}
