import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type {
  AgentStat,
  BlockEntry,
  DailyUsageEntry,
  SessionEntry,
  SkillStat,
  ToolStat,
} from "./shared.js";
import { collectAttribution } from "./attribution.js";
import { collectContinue } from "./continue.js";
import { collectCursor } from "./cursor.js";
import {
  collectClaudeNative,
  resolveClaudeConfigRoots,
  NATIVE_READ_BUDGET_MS,
  type NativeCollectResult,
} from "./native/claude.js";
import { collectCodexNative } from "./native/codex.js";
import { plausibleUsageDate } from "./native/usage-date.js";
import { collectVscodeAgent, VSCODE_AGENTS } from "./native/vscode-agents.js";
import { loadLivePricing } from "./pricing-live.js";
import {
  loadProvenanceStore,
  provenanceStorePath,
  reconcileProvenance,
  saveProvenanceStore,
} from "./provenance-store.js";

/**
 * Sources our OWN native readers cover. ccusage is only ever a fallback for
 * these (see `selectSourceEntries`), so `collectAll` no longer probes them in
 * the parallel phase — doing so re-read the very same multi-GB transcript
 * corpus concurrently with the reader it exists to back up.
 */
export const NATIVE_COVERED_SOURCES = new Set(["claude", "codex"]);

/**
 * Wall-clock cap for one ccusage probe. Generous for the ordinary case: a
 * source with no data on disk answers in well under a second, so this only ever
 * bites a source that really is reading a large corpus.
 */
export const CCUSAGE_TIMEOUT_MS = 25_000;

/**
 * Cap for the claude/codex FALLBACK probe. It re-reads the same corpus the
 * native reader just failed to finish, so it gets the native reader's budget:
 * a fallback that gives up sooner than the reader it replaces can never rescue
 * the run it exists for. (With the old shared 25s cap against a 45s reader, a
 * corpus too big for the reader was by construction too big for the fallback —
 * and Claude Code vanished from the payload entirely.)
 */
export const CCUSAGE_FALLBACK_TIMEOUT_MS = NATIVE_READ_BUDGET_MS;

/**
 * `session` and `blocks` are NOT per-source: each re-reads EVERY agent's
 * transcripts in one child, so it does roughly the work of all the per-source
 * children combined — while those children run concurrently against the same
 * disk. On a large corpus the short per-source cap is therefore too small by
 * construction: the call and its retry both timed out, runCcusage returned
 * null, and payload.sessions stayed empty on every run. Since per-day message
 * counts reach the server only through sessions[].messageCount (DailyUsageEntry
 * has no message field), dashboards showed "0 messages" indefinitely.
 */
export const CCUSAGE_AGGREGATE_TIMEOUT_MS = 180_000;

/** Sources ccusage can read, in the order we probe them. */
export const SOURCES = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "opencode",
  "amp",
  "droid",
  "goose",
  "kimi",
  "qwen",
  "kilo",
  "openclaw",
  "hermes",
  "pi",
  "codebuff",
] as const;

function norm(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function normCost(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Map one ccusage daily report (per-source `date` or aggregate `period`
 * variant) to leaderboard entries: one entry per day per model.
 */
export function mapCcusageDaily(
  tool: string,
  json: unknown,
  now: number = Date.now(),
): DailyUsageEntry[] {
  const daily = (json as { daily?: unknown[] } | null)?.daily;
  if (!Array.isArray(daily)) return [];

  const entries: DailyUsageEntry[] = [];
  for (const rawDay of daily) {
    const day = rawDay as Record<string, unknown>;
    const date = (day.date ?? day.period) as string | undefined;
    if (typeof date !== "string" || !plausibleUsageDate(date, now)) continue;

    const breakdowns = Array.isArray(day.modelBreakdowns)
      ? (day.modelBreakdowns as Record<string, unknown>[])
      : [];
    const modelsMap =
      day.models && typeof day.models === "object" && !Array.isArray(day.models)
        ? (day.models as Record<string, Record<string, unknown>>)
        : null;
    const dayCost = normCost(day.totalCost ?? day.costUSD);

    let candidates: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      costUSD: number;
    }>;
    if (breakdowns.length > 0) {
      candidates = breakdowns.map((b) => ({
        model: typeof b.modelName === "string" ? b.modelName : "unknown",
        inputTokens: norm(b.inputTokens),
        outputTokens: norm(b.outputTokens),
        cacheCreationTokens: norm(b.cacheCreationTokens),
        cacheReadTokens: norm(b.cacheReadTokens),
        costUSD: normCost(b.cost),
      }));
    } else if (modelsMap && Object.keys(modelsMap).length > 0) {
      // Codex-style: per-model tokens with only a day-level cost.
      // Attribute the cost proportionally to each model's tokens.
      const partial = Object.entries(modelsMap).map(([model, m]) => ({
        model,
        inputTokens: norm(m.inputTokens),
        outputTokens: norm(m.outputTokens),
        cacheCreationTokens: norm(m.cacheCreationTokens),
        cacheReadTokens: norm(m.cacheReadTokens),
      }));
      const tokenSum = partial.reduce(
        (s, c) =>
          s + c.inputTokens + c.outputTokens + c.cacheCreationTokens + c.cacheReadTokens,
        0,
      );
      candidates = partial.map((c) => {
        const tokens =
          c.inputTokens + c.outputTokens + c.cacheCreationTokens + c.cacheReadTokens;
        return {
          ...c,
          costUSD: tokenSum > 0 ? (dayCost * tokens) / tokenSum : 0,
        };
      });
    } else {
      // Sources like droid and opencode report only day-level tokens plus a
      // `modelsUsed` list — there is no per-model breakdown to split the tokens
      // across. When the whole day ran a single model we attribute it to that
      // model; a mixed-model day stays "unknown" because we can't divide the
      // day-level totals between them without fabricating a split.
      const modelsUsed = Array.isArray(day.modelsUsed)
        ? (day.modelsUsed as unknown[]).filter(
            (m): m is string => typeof m === "string" && m.length > 0,
          )
        : [];
      candidates = [
        {
          model: modelsUsed.length === 1 ? modelsUsed[0] : "unknown",
          inputTokens: norm(day.inputTokens),
          outputTokens: norm(day.outputTokens),
          cacheCreationTokens: norm(day.cacheCreationTokens),
          cacheReadTokens: norm(day.cacheReadTokens),
          costUSD: dayCost,
        },
      ];
    }

    for (const c of candidates) {
      const tokens =
        c.inputTokens +
        c.outputTokens +
        c.cacheCreationTokens +
        c.cacheReadTokens;
      if (tokens === 0 && c.costUSD === 0) continue;
      // CLI-collected usage from local ccusage logs: origin "cli", unverified.
      entries.push({ date, tool, ...c, origin: "cli", verified: false });
    }
  }
  return entries;
}

/** Map `ccusage session` JSON to per-conversation entries (aggregate only). */
export function mapCcusageSessions(json: unknown): SessionEntry[] {
  const sessions = (json as { session?: unknown[] } | null)?.session;
  if (!Array.isArray(sessions)) return [];
  const out: SessionEntry[] = [];
  for (const raw of sessions) {
    const s = raw as Record<string, unknown>;
    const sessionId =
      typeof s.period === "string"
        ? s.period
        : typeof s.sessionId === "string"
          ? s.sessionId
          : null;
    if (!sessionId) continue;
    const inputTokens = norm(s.inputTokens);
    const outputTokens = norm(s.outputTokens);
    const cacheCreationTokens = norm(s.cacheCreationTokens);
    const cacheReadTokens = norm(s.cacheReadTokens);
    if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0)
      continue;
    const models = Array.isArray(s.modelsUsed)
      ? (s.modelsUsed as unknown[]).filter((m): m is string => typeof m === "string")
      : [];
    const meta = (s.metadata ?? {}) as { lastActivity?: unknown };
    out.push({
      sessionId: sessionId.slice(0, 128),
      tool: typeof s.agent === "string" ? s.agent : "unknown",
      model: models[0] ?? "unknown",
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUSD: normCost(s.totalCost ?? s.costUSD),
      lastActivity:
        typeof meta.lastActivity === "string"
          ? meta.lastActivity
          : new Date().toISOString(),
    });
  }
  return out;
}

/** Map `ccusage blocks` JSON to time-window entries for peak-hours analysis. */
export function mapCcusageBlocks(json: unknown): BlockEntry[] {
  const blocks = (json as { blocks?: unknown[] } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: BlockEntry[] = [];
  for (const raw of blocks) {
    const b = raw as Record<string, unknown>;
    if (b.isGap === true) continue;
    if (typeof b.startTime !== "string") continue;
    const totalTokens = norm(b.totalTokens);
    const costUSD = normCost(b.costUSD);
    if (totalTokens === 0 && costUSD === 0) continue;
    out.push({ startTime: b.startTime, totalTokens, costUSD });
  }
  return out;
}

/** Locate the ccusage executable installed as our dependency. */
export function resolveCcusageBin(): { cmd: string; prefixArgs: string[] } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("ccusage/package.json");
  const pkg = require("ccusage/package.json") as {
    bin?: string | Record<string, string>;
  };
  const rel =
    typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.ccusage ?? "ccusage");
  const binPath = join(dirname(pkgPath), rel);
  if (/\.(c|m)?js$/.test(binPath)) {
    return { cmd: process.execPath, prefixArgs: [binPath] };
  }
  return { cmd: binPath, prefixArgs: [] };
}

export interface CollectResult {
  entries: DailyUsageEntry[];
  sessions: SessionEntry[];
  blocks: BlockEntry[];
  toolsFound: string[];
  /** Tool-call frequencies parsed from local transcripts (names + counts + errors). */
  tools: ToolStat[];
  /** Skill-usage frequencies parsed from local transcripts. */
  skills: SkillStat[];
  /** Subagent-vs-main rollup parsed from local transcripts. */
  agent: AgentStat;
  /** True when transcript scanning finished within its time budget (full snapshot). */
  attributionComplete: boolean;
}

/**
 * Collapse entries that share a server-side unique key so the payload never
 * contains a duplicate. Sending two rows with the same key makes the API's
 * `bulkWrite` race to insert the same document → a duplicate-key error → a 500
 * ("internal error") for the user. ccusage can legitimately emit such dups
 * (repeated model breakdowns, overlapping block hours, reused session ids), so
 * we merge them here before anything leaves the machine.
 */
export function dedupeDaily(entries: DailyUsageEntry[]): DailyUsageEntry[] {
  const byKey = new Map<string, DailyUsageEntry>();
  for (const e of entries) {
    const key = `${e.date}|${e.tool}|${e.model}|${e.origin}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...e });
      continue;
    }
    // Same (date,tool,model,origin): these are partial counts — sum them.
    prev.inputTokens += e.inputTokens;
    prev.outputTokens += e.outputTokens;
    prev.cacheCreationTokens += e.cacheCreationTokens;
    prev.cacheReadTokens += e.cacheReadTokens;
    prev.costUSD = Number((prev.costUSD + e.costUSD).toFixed(6));
    prev.verified = prev.verified && e.verified;
    // Sum the request-id fingerprint too (only present on native-reader rows);
    // if either side carries one, the merged row should reflect the total.
    if (e.requestCount !== undefined || prev.requestCount !== undefined) {
      prev.requestCount = (prev.requestCount ?? 0) + (e.requestCount ?? 0);
    }
  }
  return [...byKey.values()];
}

/** Token total of a daily/session entry (the four token fields). */
function entryTokens(e: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
}

/**
 * Cap an array to the server's accepted maximum, keeping the highest-token rows.
 * A no-op when already within the limit (preserves order). Guards against the
 * server rejecting an oversized payload (zod `.max(...)`) with a 400 — a heavy
 * user gets a capped-but-accepted submit instead of a hard failure.
 */
export function capByTokens<T>(rows: T[], max: number, tokens: (r: T) => number): T[] {
  if (rows.length <= max) return rows;
  return [...rows].sort((a, b) => tokens(b) - tokens(a)).slice(0, max);
}

/** Drop duplicate session ids (keep the row with the most tokens). */
export function dedupeSessions(sessions: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  const total = (s: SessionEntry) =>
    s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  for (const s of sessions) {
    const prev = byId.get(s.sessionId);
    if (!prev || total(s) >= total(prev)) byId.set(s.sessionId, s);
  }
  return [...byId.values()];
}

/** Merge blocks that share a start time (sum their totals). */
export function dedupeBlocks(blocks: BlockEntry[]): BlockEntry[] {
  const byStart = new Map<string, BlockEntry>();
  for (const b of blocks) {
    const prev = byStart.get(b.startTime);
    if (!prev) {
      byStart.set(b.startTime, { ...b });
      continue;
    }
    prev.totalTokens += b.totalTokens;
    prev.costUSD = Number((prev.costUSD + b.costUSD).toFixed(6));
  }
  return [...byStart.values()];
}

/**
 * Choose the authoritative entries for a source: prefer our own native reader
 * (correct dedup + the anti-fraud request-id fingerprint) for claude/codex, and
 * fall back to the ccusage-mapped entries only when the native reader found no
 * transcripts on disk. ccusage stays the reader for every other source.
 */
export function selectSourceEntries(
  source: string,
  ccusageEntries: DailyUsageEntry[],
  native: { claude: NativeCollectResult; codex: NativeCollectResult },
): DailyUsageEntry[] {
  if (source === "claude" && nativeReaderWon(native.claude))
    return native.claude.entries;
  if (source === "codex" && nativeReaderWon(native.codex))
    return native.codex.entries;
  return ccusageEntries;
}

/**
 * Did a native reader produce usable entries? When it did, ccusage is not
 * consulted for that source at all — which is why `collectAll` can decide
 * whether the fallback probe is needed BEFORE paying for it.
 */
export function nativeReaderWon(result: NativeCollectResult): boolean {
  return result.found && result.entries.length > 0;
}

/**
 * The natively-covered sources that still need a ccusage fallback this run —
 * i.e. the ones whose native reader came back without usable entries (empty
 * disk, a timeout, or a throw). Returned in SOURCES order so the fallback pass
 * is deterministic. Everything else is either already covered natively or was
 * probed in the parallel phase.
 */
export function ccusageFallbackSources(native: {
  claude: NativeCollectResult;
  codex: NativeCollectResult;
}): string[] {
  return SOURCES.filter(
    (s) =>
      NATIVE_COVERED_SOURCES.has(s) &&
      !nativeReaderWon(s === "claude" ? native.claude : native.codex),
  );
}

/**
 * Environment for a ccusage child reading Claude logs. When the user hasn't set
 * CLAUDE_CONFIG_DIR we set it EXPLICITLY to both known roots (~/.claude AND
 * ~/.config/claude) so the fallback scans both even if ccusage's own default
 * ever narrows — reading only one of the two after Claude Code's dir migration
 * is a real ccusage miscount cause. A user-set value is respected verbatim.
 */
export function ccusageClaudeEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()) return env;
  return { ...env, CLAUDE_CONFIG_DIR: resolveClaudeConfigRoots(env).join(",") };
}

/**
 * Should a failed ccusage probe be retried once?
 *
 * execFile rejects on our own timeout (`killed`), an external signal, a spawn
 * failure (string `code` like ENOENT), or a clean non-zero exit (numeric
 * `code`). Only a spawn failure or an EXTERNAL kill is worth retrying — a busy
 * machine or an OOM-killed pass really can succeed the second time.
 *
 * Our OWN timeout is NOT retried. It means the corpus doesn't fit the budget,
 * which is deterministic: the retry burns another full budget of CPU to fail
 * identically. That doubled cost is not free — it lands on the exact machine
 * already struggling and starves the native readers running alongside, making
 * the silent source drop-out this retry exists to prevent MORE likely. A clean
 * non-zero exit isn't retried either (keeps "not installed" fast).
 */
export function isRetryableCcusageFailure(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string | null;
  };
  if (e.killed === true) return false; // our own timeout — deterministic
  return e.signal != null || typeof e.code === "string";
}

async function runCcusageOnce(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = CCUSAGE_TIMEOUT_MS,
): Promise<{ json: unknown | null; transient: boolean }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // A single source shouldn't be able to hang the whole run: a hung source
      // gets killed and (if transient) retried once below rather than stalling
      // everything for minutes. The claude/codex fallback passes a longer cap —
      // see CCUSAGE_FALLBACK_TIMEOUT_MS.
      timeout: timeoutMs,
      ...(env ? { env } : {}),
    });
    if (!stdout) return { json: null, transient: false };
    try {
      return { json: JSON.parse(stdout), transient: false };
    } catch {
      return { json: null, transient: false };
    }
  } catch (err) {
    return { json: null, transient: isRetryableCcusageFailure(err) };
  }
}

async function runCcusage(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = CCUSAGE_TIMEOUT_MS,
): Promise<unknown | null> {
  const first = await runCcusageOnce(cmd, args, env, timeoutMs);
  if (first.json !== null || !first.transient) return first.json;
  // One retry on a transient failure so a flaky source stays in the report
  // run-to-run (data consistency) rather than dropping out intermittently.
  return (await runCcusageOnce(cmd, args, env, timeoutMs)).json;
}

/**
 * Progress callback for the collection pipeline: invoked once per stage with the
 * number of stages completed, the total, and a short label for the stage just
 * started. Drives the CLI's loading bar; optional everywhere else.
 */
export type ProgressFn = (done: number, total: number, label: string) => void;

/**
 * Total number of collection stages: the ccusage sources, plus the fixed extra
 * ticking tasks — sessions, blocks, cursor, attribution (4), and the native
 * non-ccusage readers cline, roo, continue (VSCODE_AGENTS.length + 1).
 */
export const COLLECT_STAGES = SOURCES.length + 4 + VSCODE_AGENTS.length + 1;

/**
 * A run is AUTHORITATIVE — safe to lower a stored requestCount fingerprint —
 * only when the attribution scan finished AND neither native fingerprint reader
 * bailed. A reader bails either by timing out or by THROWING (its catch-fallback
 * sets `timedOut: true`); both mean its fingerprints are missing for days that
 * may still be submitted from ccusage, so trusting the current scan would emit a
 * zero requestCount that reads as forgery. When not authoritative, the caller
 * runs the partial-run anti-regression guard, which only ever holds/raises a
 * stored fingerprint, never lowers it. A genuinely-empty reader (found:false
 * with no timeout/throw) stays authoritative — it shares ccusage's data source,
 * so "nothing here" is real, not a bailed read.
 */
export function isAuthoritativeScan(
  attributionComplete: boolean,
  ...fingerprintReaders: Array<Pick<NativeCollectResult, "timedOut">>
): boolean {
  return (
    attributionComplete &&
    fingerprintReaders.every((reader) => reader.timedOut !== true)
  );
}

/** Run ccusage for every known source, add Cursor, and merge the results. */
export async function collectAll(onProgress?: ProgressFn): Promise<CollectResult> {
  // Freshen the pricing table BEFORE any reader prices an entry (24h disk
  // cache, ~5s network cap on a cold day, silent fallback to the baked
  // snapshot). This is what keeps costUSD current on already-installed CLIs.
  await loadLivePricing().catch(() => {});

  const { cmd, prefixArgs } = resolveCcusageBin();
  let done = 0;
  // Each task bumps the bar as it finishes. Because everything runs at once,
  // stages complete out of order — the bar tracks the count, not the sequence.
  const tick = () => onProgress?.(++done, COLLECT_STAGES, "");

  // Everything below is independent, so fire it all off concurrently instead of
  // one source after another. The old sequential pass walked 15 `ccusage` spawns
  // (plus session/blocks/cursor/transcripts) back-to-back and dominated the wall
  // time; in parallel the run finishes in roughly the slowest single probe.
  // Our own correct readers for the two primary agents (Claude Code, Codex).
  // These run alongside ccusage and WIN when they find transcripts — they fix
  // ccusage's over/under-count and add the request-id fingerprint the server
  // uses for anti-fraud. ccusage remains the fallback (and the only reader for
  // every other source).
  // A THROW here is a bailed scan, not "no data" — the reader may have crashed
  // mid-parse on a day ccusage can still read, so its fingerprint is missing for
  // days that DO get submitted. Mark it like a timeout (`timedOut: true`) so the
  // anti-regression guard below treats the run as partial and re-attaches the
  // last-good requestCount instead of emitting a zero that reads as forgery.
  const nativeClaudeTask = collectClaudeNative().catch(
    () =>
      ({ entries: [], found: false, filesScanned: 0, timedOut: true }) as NativeCollectResult,
  );
  const nativeCodexTask = collectCodexNative().catch(
    () =>
      ({ entries: [], found: false, filesScanned: 0, timedOut: true }) as NativeCollectResult,
  );

  const sourceTasks = SOURCES.map(async (source) => {
    // claude/codex are read by the native readers above; ccusage is only their
    // FALLBACK, so it is not probed here. Racing it against the reader it backs
    // up meant two concurrent full passes over the same multi-GB corpus (plus
    // the attribution scan over a third) — on a heavy machine that contention
    // pushed the reader past its budget AND killed the 25s fallback, and the
    // source silently vanished from the payload. The fallback now runs after
    // this phase, only if it is actually needed. This stage's tick tracks the
    // native reader instead, so the bar reflects the work really in flight.
    if (NATIVE_COVERED_SOURCES.has(source)) {
      await (source === "claude" ? nativeClaudeTask : nativeCodexTask);
      tick();
      return { source, mapped: [] as DailyUsageEntry[] };
    }
    const json = await runCcusage(cmd, [
      ...prefixArgs,
      source,
      "daily",
      "--json",
      "--offline",
    ]);
    tick();
    return { source, mapped: json ? mapCcusageDaily(source, json) : [] };
  });

  // Richer rollups, gathered once across all agents (ccusage aggregates them):
  // sessions power "most expensive conversations", blocks power "peak hours".
  const sessionTask = runCcusage(
    cmd,
    [...prefixArgs, "session", "--json", "--offline"],
    undefined,
    CCUSAGE_AGGREGATE_TIMEOUT_MS,
  ).then((json) => {
    tick();
    return json ? mapCcusageSessions(json) : [];
  });
  const blockTask = runCcusage(
    cmd,
    [...prefixArgs, "blocks", "--json", "--offline"],
    undefined,
    CCUSAGE_AGGREGATE_TIMEOUT_MS,
  ).then((json) => {
    tick();
    return json ? mapCcusageBlocks(json) : [];
  });
  // Cursor isn't a ccusage source — pull it from the local Cursor session +
  // dashboard API (best effort; no-op if Cursor isn't installed/signed in).
  const cursorTask = collectCursor().then((c) => {
    tick();
    return c;
  });
  // Tool/skill/subagent rollups from Claude Code transcripts (ccusage can't see
  // these). Async + yielding, so the loading bar keeps moving while it scans.
  // Per-session message counts join onto the session rollups by sessionId
  // (ccusage's session id is the transcript uuid).
  const attributionTask = collectAttribution().then((a) => {
    tick();
    return a;
  });
  // Non-ccusage native readers for the Cline-lineage VS Code agents (Cline, Roo)
  // and Continue.dev. Best effort like cursor: a no-op (found:false) when the
  // agent isn't installed, and they emit the same anti-fraud requestCount the
  // other native readers do.
  const vscodeTasks = VSCODE_AGENTS.map((a) =>
    collectVscodeAgent({ tool: a.tool, extIds: a.extIds }).then((r) => {
      tick();
      return { tool: a.tool, result: r };
    }),
  );
  const continueTask = collectContinue().then((r) => {
    tick();
    return r;
  });

  const [
    sourceResults,
    sessions,
    blocks,
    cursor,
    attribution,
    nativeClaude,
    nativeCodex,
    vscodeResults,
    continueResult,
  ] = await Promise.all([
    Promise.all(sourceTasks),
    sessionTask,
    blockTask,
    cursorTask,
    attributionTask,
    nativeClaudeTask,
    nativeCodexTask,
    Promise.all(vscodeTasks),
    continueTask,
  ]);

  const native = { claude: nativeClaude, codex: nativeCodex };

  // Deferred ccusage fallback for the natively-covered sources: only for the
  // ones whose native reader produced nothing usable, and only now that the
  // parallel phase is done, so the fallback gets the machine to itself. It also
  // runs on the native reader's budget (CCUSAGE_FALLBACK_TIMEOUT_MS) rather than
  // the short probe cap. Both together are what keep a heavy Claude Code user's
  // usage in the payload instead of silently dropping it.
  const fallbacks = new Map<string, DailyUsageEntry[]>();
  for (const source of ccusageFallbackSources(native)) {
    const json = await runCcusage(
      cmd,
      [...prefixArgs, source, "daily", "--json", "--offline"],
      // For Claude, force ccusage to scan both config roots (dual-dir hardening).
      source === "claude" ? ccusageClaudeEnv() : undefined,
      CCUSAGE_FALLBACK_TIMEOUT_MS,
    );
    fallbacks.set(source, json ? mapCcusageDaily(source, json) : []);
  }

  const entries: DailyUsageEntry[] = [];
  const toolsFound: string[] = [];
  // Re-assemble in SOURCES order so the "from claude, codex, …" line stays stable.
  // For claude/codex the native reader's entries win over ccusage's (see
  // selectSourceEntries); every other source keeps ccusage's mapped entries.
  for (const { source, mapped } of sourceResults) {
    const chosen = selectSourceEntries(source, fallbacks.get(source) ?? mapped, native);
    if (chosen.length > 0) {
      entries.push(...chosen);
      toolsFound.push(source);
    }
  }
  if (cursor.found) {
    entries.push(...cursor.entries);
    blocks.push(...cursor.blocks);
    toolsFound.push("cursor");
  }
  // Cline / Roo (VS Code globalStorage tasks) and Continue.dev — additive; each
  // no-ops when its agent isn't present.
  for (const { tool, result } of vscodeResults) {
    if (result.found && result.entries.length > 0) {
      entries.push(...result.entries);
      toolsFound.push(tool);
    }
  }
  if (continueResult.found && continueResult.entries.length > 0) {
    entries.push(...continueResult.entries);
    toolsFound.push("continue");
  }

  const { tools, skills, agent, sessionMessages, complete } = attribution;
  onProgress?.(COLLECT_STAGES, COLLECT_STAGES, "");

  const dedupedSessions = dedupeSessions(sessions).map((s) => {
    const messageCount = sessionMessages.get(s.sessionId);
    return {
      ...s,
      ...(messageCount ? { messageCount } : {}),
    };
  });

  // Re-attach last-good provenance so a partial/timed-out run never regresses a
  // day's requestCount fingerprint (or the agent rollup) below a value a prior
  // run already established. "Full snapshot" here is conservative: the
  // attribution scan finished AND neither native reader bailed — if either
  // scan bailed, treat the run as partial so the anti-regression guard engages.
  const scanComplete = isAuthoritativeScan(
    complete,
    nativeClaude,
    nativeCodex,
    ...vscodeResults.map(({ result }) => result),
    continueResult,
  );
  const storePath = provenanceStorePath();
  const reconciled = reconcileProvenance(
    dedupeDaily(entries),
    agent,
    scanComplete,
    loadProvenanceStore(storePath),
  );
  saveProvenanceStore(storePath, reconciled.store);

  return {
    // Cap each array to the server's accepted maximum (the shared SubmitPayload
    // schema: entries ≤ 20000, sessions/blocks ≤ 10000), keeping the
    // highest-token rows. Without this, a power user with >10000 distinct sessions
    // would have their ENTIRE submit rejected with a 400 instead of a capped one.
    // tools/skills are already bounded upstream (attribution caps).
    entries: capByTokens(reconciled.entries, 20000, entryTokens),
    sessions: capByTokens(dedupedSessions, 10000, entryTokens),
    blocks: capByTokens(dedupeBlocks(blocks), 10000, (b) => b.totalTokens),
    toolsFound,
    tools,
    skills,
    agent: reconciled.agent,
    attributionComplete: complete,
  };
}
