/**
 * Generic, self-discovering reader for coding agents.
 *
 * Why this exists: until now every agent needed its own hand-written parser —
 * one file per CLI, one shape per format, and a new agent meant a new release
 * before its tokens reached the leaderboard. That does not scale, and it is
 * why Qoder (and anything else that wasn't on ccusage's list) simply never
 * appeared.
 *
 * The bet here is that the AGENT is the variable and the SHAPE is not. Most
 * coding agents are forks of one another, so their local transcripts already
 * agree on a handful of usage shapes, and the model is recorded in the record
 * itself. So instead of a parser per CLI this file has:
 *
 *   1. a list of directories to LOOK at (data, not code — adding an agent is
 *      one string), plus a bounded sweep of the home directory so an agent we
 *      have never heard of is still found;
 *   2. a shape-detecting extractor that recognises the usage record shapes
 *      that are actually in the wild, and pulls the MODEL out of the record
 *      rather than from a hardcoded list;
 *   3. a double-count guard, so anything ccusage (or one of our own readers)
 *      already owns is skipped rather than counted twice.
 *
 * The shapes we recognise, all verified against real transcripts:
 *
 *   Claude-style   {"type":"assistant","timestamp":"…","message":{"model":"…",
 *                   "usage":{"input_tokens":N,"output_tokens":M,
 *                   "cache_creation_input_tokens":C,"cache_read_input_tokens":R}}}
 *   OpenCode-style {"role":"assistant","time":{"created":<epoch ms>},"modelID":"…",
 *                   "tokens":{"input":N,"output":M,"reasoning":R,
 *                   "cache":{"read":C,"write":W}}}
 *   camelCase      usage.{inputTokens,outputTokens,cacheCreationTokens,
 *                   cacheReadTokens} (Cline and several other forks)
 *
 * Anything the extractor can't read is skipped silently. This reader never
 * guesses: a record with no tokens, no timestamp, or no model produces
 * nothing, because a wrong number on a public leaderboard is worse than a
 * missing one.
 *
 * DOUBLE-COUNTING is the one thing that could actually hurt a user here, so
 * it is guarded twice. Statically: any directory whose agent id is one ccusage
 * reads (or that one of our own native readers owns) is skipped outright —
 * ccusage is asked for each of those agents every run, so counting them here
 * too would inflate the leaderboard. Dynamically: the caller passes the set of
 * agents ccusage actually reported this run, and we skip those too, which
 * covers a ccusage release that adds an agent we don't know about yet.
 */
import { readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";
import type { NativeCollectResult } from "./claude.js";
import { nativeCachePath, readFilesWithCache } from "./file-cache.js";
import { localUsageDate } from "./usage-date.js";

/**
 * Agent ids ccusage reads. We skip these directories so the same usage is not
 * counted twice. The list is the union across ccusage versions we know about
 * (20.0.19 through 20.0.37): being conservative here can only cost us a
 * missing agent, never a doubled one, and the server treats a repeated
 * (date, tool, model) scope as a replacement — so a double count would
 * silently inflate a public number.
 */
export const CCUSAGE_AGENT_IDS: ReadonlySet<string> = new Set([
  "amp",
  "antigravity",
  "claude",
  "codebuff",
  "codex",
  "copilot",
  "droid",
  "gemini",
  "goose",
  "grok",
  "hermes",
  "kilo",
  "kimi",
  "openclaw",
  "opencode",
  "pi",
  "qwen",
  "zcode",
]);

/**
 * Agent ids our own native readers own. Same reasoning as above: the Cline /
 * Roo / Continue / Cursor / Qoder readers already produce these.
 */
export const NATIVE_READER_AGENT_IDS: ReadonlySet<string> = new Set([
  "cline",
  "continue",
  "cursor",
  "qoder",
  "roo",
]);

/**
 * Directory basenames whose agent id differs from the directory name.
 * ccusage calls Factory "droid"; the directory is `~/.factory`.
 */
const DIR_NAME_TO_AGENT_ID: Record<string, string> = {
  factory: "droid",
};

/**
 * Agent home directories to look at. This is DATA: adding support for a new
 * agent is one string here, not a new parser. Anything ccusage already reads
 * is filtered out below, so the list can be generous.
 */
const AGENT_HOME_DIRS: readonly string[] = [
  ".agents",
  ".aider",
  ".amp",
  ".antigravity",
  ".augment",
  ".cline",
  ".cody",
  ".codebuff",
  ".codeium",
  ".codex",
  ".claude",
  ".continue",
  ".crush",
  ".cursor",
  ".deepchat",
  ".droid",
  ".factory",
  ".gemini",
  ".goose",
  ".grok",
  ".hermes",
  ".iflow",
  ".junie",
  ".kilo",
  ".kimi",
  ".kiro",
  ".mavis",
  ".neovate",
  ".openclaw",
  ".opencode",
  ".pochi",
  ".qoder",
  ".qwen",
  ".roo",
  ".trae",
  ".void",
  ".warp",
  ".windsurf",
  ".zcode",
];

/**
 * Directories that are never agent homes. They are large, they are not
 * transcripts, and walking them would blow the reader's time budget.
 */
const NEVER_AGENT_DIRS: ReadonlySet<string> = new Set([
  ".bun",
  ".cache",
  ".cargo",
  ".config",
  ".git",
  ".gradle",
  ".local",
  ".m2",
  ".npm",
  ".nuget",
  ".rustup",
  ".ssh",
  ".vscode",
  "node_modules",
]);

/** Per-root walk limits. A home directory is not a small place. */
const MAX_DIR_DEPTH = 5;
const MAX_FILES_PER_ROOT = 1_000;
const MAX_DIRS_PER_ROOT = 2_000;
/** A transcript larger than this is not something we want to parse. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The sweep gets its own slice of the run, not the whole native budget. */
export const DISCOVER_BUDGET_MS = 15_000;

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** A non-empty string, or null. */
function readString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

/** The four token buckets we report. */
interface TokenQuad {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

function quadTotal(q: TokenQuad): number {
  return q.input + q.output + q.cacheCreation + q.cacheRead;
}

/**
 * Read a token quadruple out of a usage-ish object, tolerating the key
 * spellings the wild uses. Returns null when the object carries no tokens at
 * all — that is the signal that this record is not a usage record.
 */
function readTokenQuad(raw: unknown): TokenQuad | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;

  // OpenCode-style nested cache bucket.
  const cache = u.cache;
  const cacheObj = cache && typeof cache === "object" ? (cache as Record<string, unknown>) : null;

  const input = num(
    u.inputTokens ?? u.input_tokens ?? u.input ?? u.promptTokens ??
      u.prompt_tokens ?? u.promptTokenCount,
  );
  const output = num(
    u.outputTokens ?? u.output_tokens ?? u.output ??
      u.completionTokens ?? u.completion_tokens ?? u.completionTokenCount,
  );
  // `reasoning` tokens are generated tokens; count them as output.
  const reasoning = num(u.reasoningTokens ?? u.reasoning);
  const cacheCreation = num(
    u.cacheCreationTokens ?? u.cache_creation_input_tokens ??
      u.cacheCreationInputTokens ?? u.cache_creation_tokens ??
      u.cacheWriteTokens ?? u.cache_write_tokens,
  );
  const cacheRead = num(
    u.cacheReadTokens ?? u.cache_read_input_tokens ??
      u.cacheReadInputTokens ?? u.cache_read_tokens ??
      u.cachedTokens,
  );
  const nestedWrite = cacheObj ? num(cacheObj.write) : 0;
  const nestedRead = cacheObj ? num(cacheObj.read) : 0;

  const q: TokenQuad = {
    input,
    output: output + reasoning,
    cacheCreation: cacheCreation || nestedWrite,
    cacheRead: cacheRead || nestedRead,
  };
  return quadTotal(q) > 0 ? q : null;
}

/** Pull a model id out of a record, wherever the agent put it. */
function readModel(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const direct = readString(c);
    if (direct) return direct;
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      for (const key of ["model", "modelID", "model_id", "modelName", "model_name"]) {
        const v = readString(o[key]);
        if (v) return v;
      }
    }
  }
  return null;
}

/** Pull a timestamp out of a record, in any of the shapes agents use. */
function readTimestampMs(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) {
      // 10-digit values are seconds, 13-digit are milliseconds.
      return c >= 1e12 ? c : c * 1000;
    }
    if (typeof c === "string" && c.trim()) {
      const parsed = Date.parse(c);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      for (const key of ["created", "createdAt", "created_at", "time", "ts"]) {
        const v = o[key];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          return v >= 1e12 ? v : v * 1000;
        }
        if (typeof v === "string" && v.trim()) {
          const parsed = Date.parse(v);
          if (Number.isFinite(parsed)) return parsed;
        }
      }
    }
  }
  return null;
}

/** One reconstructed usage row. */
export interface DiscoveredUsage {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /**
   * A per-request identity used to collapse the duplicate records that forked
   * or rebuilt sessions leave behind. Empty when the agent doesn't expose one.
   */
  dedupeKey: string;
}

/**
 * PURE core: pull every usage row out of one JSONL transcript.
 *
 * `agentId` is the fallback model name for agents that don't record a model
 * (the same fallback the Cline/Roo reader uses) — the tool id is at least
 * honest about not knowing more.
 */
export function extractUsageRows(
  content: string,
  agentId: string,
): DiscoveredUsage[] {
  const rows: DiscoveredUsage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // not JSONL, or a corrupt line
    }

    const message = rec.message;
    const msgObj =
      message && typeof message === "object"
        ? (message as Record<string, unknown>)
        : undefined;

    // Only an ASSISTANT turn is a model request. This guard is not
    // cosmetic: Claude Code (and the transcripts that copy its format)
    // replicate the previous turn's `usage` onto the following user /
    // tool_result record, so without it every request would be counted
    // twice — once for the assistant turn and once for the user turn that
    // quotes it. The Claude native reader makes the same check.
    if (typeof rec.type === "string" && rec.type !== "assistant") continue;
    if (typeof rec.role === "string" && rec.role !== "assistant") continue;
    if (msgObj && typeof msgObj.role === "string" && msgObj.role !== "assistant") {
      continue;
    }

    // Every place a usage object can hide.
    const usageSources: unknown[] = [];
    if (msgObj) usageSources.push(msgObj.usage, msgObj.tokens);
    usageSources.push(rec.usage, rec.tokens);

    let quad: TokenQuad | null = null;
    for (const src of usageSources) {
      quad = readTokenQuad(src);
      if (quad) break;
    }
    if (!quad) continue;

    const ts = readTimestampMs(
      rec.timestamp,
      rec.createdAt,
      rec.created_at,
      rec.ts,
      rec.time,
      msgObj?.time,
      msgObj?.timestamp,
    );
    const date = ts === null ? null : localUsageDate(ts);
    if (!date) continue;

    const model = readModel(msgObj, rec) ?? agentId;

    // A request identity, when the agent records one. Claude-style records
    // carry `message.id` + `requestId`; forks duplicate those pairs, and the
    // max-wins dedup at merge time collapses them. The model is part of the
    // key: two records with the same id but different models are not the same
    // request, and collapsing them would lose a model from the report.
    const requestId = readString(rec.requestId, rec.request_id);
    const messageId = readString(msgObj?.id, rec.messageId, rec.message_id);
    const dedupeKey =
      messageId || requestId ? `${model}|${messageId ?? ""}|${requestId ?? ""}` : "";

    rows.push({
      date,
      model,
      inputTokens: quad.input,
      outputTokens: quad.output,
      cacheCreationTokens: quad.cacheCreation,
      cacheReadTokens: quad.cacheRead,
      dedupeKey,
    });
  }
  return rows;
}

/** Cached row: the usage fields plus the agent id and dedupe key. */
export type DiscoveredCachedRow = [
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  string,
];

/** One discovered agent, with the models it used. */
export interface DiscoveredAgent {
  /** The tool id published to the leaderboard. */
  id: string;
  /** The models seen in that agent's transcripts. */
  models: string[];
  /** Number of usage rows found. */
  requests: number;
}

export interface CollectDiscoveredOpts {
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  now?: () => number;
  cachePath?: string;
  /**
   * Agent ids ccusage reported this run. Those are skipped: ccusage already
   * counted them, and counting them here too would double them.
   */
  skipAgentIds?: Iterable<string>;
  /** Agent ids to skip regardless (our own native readers own those). */
  alwaysSkipAgentIds?: Iterable<string>;
}

/** Map a directory basename to the agent id it should publish. */
export function agentIdFor(dirName: string): string {
  const base = dirName.replace(/^\./, "").toLowerCase();
  return DIR_NAME_TO_AGENT_ID[base] ?? base;
}

/**
 * The directories to look at: the curated list, plus a bounded sweep of the
 * home directory so an agent nobody has heard of is still found. The sweep is
 * what makes this "any CLI" rather than "any CLI we remembered".
 */
export function candidateRoots(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ id: string; dir: string }> {
  const home = env.HOME || homedir();
  const roots: Array<{ id: string; dir: string }> = [];
  const seen = new Set<string>();

  const add = (id: string, dir: string) => {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ id, dir });
  };

  for (const name of AGENT_HOME_DIRS) {
    add(agentIdFor(name), join(home, name));
  }

  // A bounded sweep of the home directory: every top-level dot-directory
  // that isn't on the never-a-agent list. This is how a brand-new agent gets
  // picked up with no code change at all.
  let homeEntries: string[] = [];
  try {
    homeEntries = readdirSync(home, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name.startsWith(".") &&
          !NEVER_AGENT_DIRS.has(e.name.toLowerCase()),
      )
      .map((e) => e.name);
  } catch {
    homeEntries = [];
  }
  for (const name of homeEntries) {
    add(agentIdFor(name), join(home, name));
  }

  // The same agents, in the layouts that don't use a dot-directory.
  const altBases = [
    join(home, ".config"),
    join(home, ".local", "share"),
    env.APPDATA ? env.APPDATA : "",
    platform() === "darwin" ? join(home, "Library", "Application Support") : "",
  ].filter(Boolean);
  for (const base of altBases) {
    for (const name of AGENT_HOME_DIRS) {
      const plain = name.replace(/^\./, "");
      add(agentIdFor(plain), join(base, plain));
    }
  }

  return roots;
}

/**
 * Collect `.jsonl` files under a root, within strict limits.
 *
 * `truncated` is reported when a limit cut the walk short. The caller must
 * then DROP this root entirely rather than submit part of it: the server
 * replaces a day's (tool, model) scope on every submit, so a partial count
 * would silently LOWER a number the leaderboard already shows. Missing is
 * better than wrong.
 */
async function listTranscriptFiles(
  root: string,
  opts: { deadline: number; now: () => number },
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let dirs = 0;
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    if (opts.now() > opts.deadline) return { files, truncated: true };
    const current = queue[queueIndex++]!;
    let dirents;
    try {
      dirents = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (opts.now() > opts.deadline) return { files, truncated: true };
      const full = join(current.dir, d.name);
      if (d.isDirectory()) {
        if (current.depth >= MAX_DIR_DEPTH) continue;
        if (NEVER_AGENT_DIRS.has(d.name.toLowerCase())) continue;
        dirs++;
        if (dirs > MAX_DIRS_PER_ROOT) return { files, truncated: true };
        queue.push({ dir: full, depth: current.depth + 1 });
      } else if (d.isFile() && d.name.endsWith(".jsonl")) {
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
        } catch {
          continue;
        }
        files.push(full);
        if (files.length >= MAX_FILES_PER_ROOT) return { files, truncated: true };
      }
    }
  }
  return { files, truncated: false };
}

/** Bump when parse/aggregate semantics change — invalidates the per-file cache. */
export const DISCOVER_CACHE_VERSION = 2;

/**
 * Read every agent home we can find and aggregate what they report.
 *
 * Best-effort and time-bounded like the other native readers: `found:false`
 * when nothing usable turned up, `timedOut:true` on a budget timeout rather
 * than submitting a partial corpus.
 */
export async function collectDiscovered(
  opts: CollectDiscoveredOpts = {},
): Promise<
  NativeCollectResult & { agents: DiscoveredAgent[]; skippedRoots: string[] }
> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? DISCOVER_BUDGET_MS);

  const skip = new Set<string>([
    ...CCUSAGE_AGENT_IDS,
    ...NATIVE_READER_AGENT_IDS,
    ...(opts.alwaysSkipAgentIds ?? []),
    ...(opts.skipAgentIds ?? []),
  ]);

  const roots = candidateRoots(env).filter((r) => !skip.has(r.id));
  if (roots.length === 0) {
    return {
      entries: [],
      found: false,
      filesScanned: 0,
      agents: [],
      skippedRoots: [],
    };
  }

  // One cache file for the whole sweep: entries are keyed by file path, and
  // the agent id travels with each row.
  const files: string[] = [];
  const agentByFile = new Map<string, string>();
  const skippedRoots: string[] = [];
  for (const root of roots) {
    if (now() > deadline) break;
    const found = await listTranscriptFiles(root.dir, { deadline, now });
    if (found.truncated) {
      // A truncated root would mean submitting PART of an agent's usage, and
      // the server replaces a day's scope on every submit — so a partial read
      // would LOWER what the leaderboard already shows. Drop the root
      // instead: missing is better than wrong.
      skippedRoots.push(root.id);
      continue;
    }
    for (const f of found.files) {
      files.push(f);
      agentByFile.set(f, root.id);
    }
  }
  if (files.length === 0) {
    return {
      entries: [],
      found: false,
      filesScanned: 0,
      agents: [],
      skippedRoots,
    };
  }

  const res = await readFilesWithCache<DiscoveredCachedRow>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("discover", env),
    version: DISCOVER_CACHE_VERSION,
    parseFile: (content, path) => {
      const agentId = agentByFile.get(path) ?? "unknown";
      return extractUsageRows(content, agentId).map((r) => [
        r.date,
        r.model,
        agentId,
        r.inputTokens,
        r.outputTokens,
        r.cacheCreationTokens,
        r.cacheReadTokens,
        r.dedupeKey,
      ]);
    },
    deadline,
    now,
  });
  if (!res.itemsByFile) {
    return {
      entries: [],
      found: false,
      filesScanned: res.filesRead,
      timedOut: true,
      agents: [],
      skippedRoots,
    };
  }

  // Merge. Rows that share a dedupe key are the same provider request seen
  // twice (a forked or rebuilt session), so the largest copy wins — the same
  // max-wins rule the Claude native reader uses. Rows with no identity are
  // their own request.
  interface Request {
    date: string;
    tool: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }
  const requests = new Map<string, Request>();
  let anonymous = 0;
  for (const rows of res.itemsByFile) {
    for (const row of rows) {
      const [date, model, tool, input, output, cacheCreation, cacheRead, dedupeKey] =
        row;
      if (!date || !tool) continue;
      if (input + output + cacheCreation + cacheRead === 0) continue;

      const request: Request = {
        date,
        tool,
        model,
        inputTokens: input,
        outputTokens: output,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
      };
      if (!dedupeKey) {
        requests.set(`anon#${anonymous++}`, request);
        continue;
      }
      const key = `${tool}|${dedupeKey}`;
      const prev = requests.get(key);
      if (!prev) {
        requests.set(key, request);
        continue;
      }
      const prevTotal =
        prev.inputTokens +
        prev.outputTokens +
        prev.cacheCreationTokens +
        prev.cacheReadTokens;
      if (input + output + cacheCreation + cacheRead > prevTotal) {
        requests.set(key, request);
      }
    }
  }

  interface Bucket {
    date: string;
    tool: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUSD: number;
    requestCount: number;
  }
  const buckets = new Map<string, Bucket>();
  const modelsByAgent = new Map<string, Set<string>>();
  const requestsByAgent = new Map<string, number>();

  for (const r of requests.values()) {
    const key = `${r.date}|${r.tool}|${r.model}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        date: r.date,
        tool: r.tool,
        model: r.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0,
        requestCount: 0,
      };
      buckets.set(key, b);
    }
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cacheCreationTokens += r.cacheCreationTokens;
    b.cacheReadTokens += r.cacheReadTokens;
    b.costUSD += estimateCostUSD(r.model, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      cacheReadTokens: r.cacheReadTokens,
    });
    b.requestCount += 1;

    const models = modelsByAgent.get(r.tool) ?? new Set<string>();
    models.add(r.model);
    modelsByAgent.set(r.tool, models);
    requestsByAgent.set(r.tool, (requestsByAgent.get(r.tool) ?? 0) + 1);
  }

  const entries: DailyUsageEntry[] = [...buckets.values()].map((b) => ({
    date: b.date,
    tool: b.tool,
    model: b.model,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheCreationTokens: b.cacheCreationTokens,
    cacheReadTokens: b.cacheReadTokens,
    costUSD: Number(b.costUSD.toFixed(6)),
    origin: "cli",
    verified: false,
    requestCount: b.requestCount,
  }));

  const agents: DiscoveredAgent[] = [...modelsByAgent.entries()]
    .map(([id, models]) => ({
      id,
      models: [...models].sort(),
      requests: requestsByAgent.get(id) ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    entries,
    found: entries.length > 0,
    filesScanned: res.filesRead,
    agents,
    skippedRoots,
  };
}
