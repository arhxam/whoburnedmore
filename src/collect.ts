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
import { collectCursor } from "./cursor.js";
import {
  collectClaudeNative,
  resolveClaudeConfigRoots,
  type NativeCollectResult,
} from "./native/claude.js";
import { collectCodexNative } from "./native/codex.js";
import { loadLivePricing } from "./pricing-live.js";
import {
  loadProvenanceStore,
  provenanceStorePath,
  reconcileProvenance,
  saveProvenanceStore,
} from "./provenance-store.js";

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
): DailyUsageEntry[] {
  const daily = (json as { daily?: unknown[] } | null)?.daily;
  if (!Array.isArray(daily)) return [];

  const entries: DailyUsageEntry[] = [];
  for (const rawDay of daily) {
    const day = rawDay as Record<string, unknown>;
    const date = (day.date ?? day.period) as string | undefined;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

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
  if (source === "claude" && native.claude.found && native.claude.entries.length > 0)
    return native.claude.entries;
  if (source === "codex" && native.codex.found && native.codex.entries.length > 0)
    return native.codex.entries;
  return ccusageEntries;
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

async function runCcusageOnce(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ json: unknown | null; transient: boolean }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // A single source shouldn't be able to hang the whole run. 25s is plenty
      // for a healthy local read; a hung source gets killed and (if transient)
      // retried once below rather than stalling everything for minutes.
      timeout: 25_000,
      ...(env ? { env } : {}),
    });
    if (!stdout) return { json: null, transient: false };
    try {
      return { json: JSON.parse(stdout), transient: false };
    } catch {
      return { json: null, transient: false };
    }
  } catch (err) {
    // execFile rejects on timeout (killed by signal), spawn failure (string
    // `code` like ENOENT), or a clean non-zero exit (numeric `code`). The first
    // two are transient (a busy machine, an OOM-killed pass) and worth one retry
    // so a source isn't silently dropped; a clean non-zero exit means the source
    // genuinely has nothing/errored — don't retry (keeps "not installed" fast).
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
    const transient = e.killed === true || e.signal != null || typeof e.code === "string";
    return { json: null, transient };
  }
}

async function runCcusage(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<unknown | null> {
  const first = await runCcusageOnce(cmd, args, env);
  if (first.json !== null || !first.transient) return first.json;
  // One retry on a transient failure so a flaky source stays in the report
  // run-to-run (data consistency) rather than dropping out intermittently.
  return (await runCcusageOnce(cmd, args, env)).json;
}

/**
 * Progress callback for the collection pipeline: invoked once per stage with the
 * number of stages completed, the total, and a short label for the stage just
 * started. Drives the CLI's loading bar; optional everywhere else.
 */
export type ProgressFn = (done: number, total: number, label: string) => void;

/** Total number of collection stages (sources + sessions/blocks/cursor/logs). */
export const COLLECT_STAGES = SOURCES.length + 4;

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
  nativeClaude: Pick<NativeCollectResult, "timedOut">,
  nativeCodex: Pick<NativeCollectResult, "timedOut">,
): boolean {
  return (
    attributionComplete &&
    nativeClaude.timedOut !== true &&
    nativeCodex.timedOut !== true
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
    // For Claude, force ccusage to scan both config roots (dual-dir hardening);
    // other sources inherit the ambient environment.
    const env = source === "claude" ? ccusageClaudeEnv() : undefined;
    const json = await runCcusage(
      cmd,
      [...prefixArgs, source, "daily", "--json", "--offline"],
      env,
    );
    tick();
    return { source, mapped: json ? mapCcusageDaily(source, json) : [] };
  });

  // Richer rollups, gathered once across all agents (ccusage aggregates them):
  // sessions power "most expensive conversations", blocks power "peak hours".
  const sessionTask = runCcusage(cmd, [...prefixArgs, "session", "--json", "--offline"]).then(
    (json) => {
      tick();
      return json ? mapCcusageSessions(json) : [];
    },
  );
  const blockTask = runCcusage(cmd, [...prefixArgs, "blocks", "--json", "--offline"]).then(
    (json) => {
      tick();
      return json ? mapCcusageBlocks(json) : [];
    },
  );
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

  const [sourceResults, sessions, blocks, cursor, attribution, nativeClaude, nativeCodex] =
    await Promise.all([
      Promise.all(sourceTasks),
      sessionTask,
      blockTask,
      cursorTask,
      attributionTask,
      nativeClaudeTask,
      nativeCodexTask,
    ]);

  const native = { claude: nativeClaude, codex: nativeCodex };
  const entries: DailyUsageEntry[] = [];
  const toolsFound: string[] = [];
  // Re-assemble in SOURCES order so the "from claude, codex, …" line stays stable.
  // For claude/codex the native reader's entries win over ccusage's (see
  // selectSourceEntries); every other source keeps ccusage's mapped entries.
  for (const { source, mapped } of sourceResults) {
    const chosen = selectSourceEntries(source, mapped, native);
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
  const scanComplete = isAuthoritativeScan(complete, nativeClaude, nativeCodex);
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
