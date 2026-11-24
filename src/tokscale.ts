import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DailyUsageEntry } from "./shared.js";
import { plausibleUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";

const execFileAsync = promisify(execFile);

/**
 * Secondary reader: the community-maintained `tokscale` CLI (a Rust binary with
 * no JS dependencies, shipped per-platform through npm optionalDependencies).
 *
 * It reads the local session stores of ~60 coding agents. We use it ONLY for the
 * agents nothing else in this CLI can see — Devin, Zed, Kiro, Crush, Augment,
 * Junie, Qoder and friends — via a single `tokscale graph` call, which returns
 * per-day × client × model token totals. Every agent already read by ccusage or
 * by one of our native readers is deliberately left out of the client list, so a
 * day is never counted twice (see TOKSCALE_EXCLUDED_CLIENTS for the reasons).
 *
 * It also backs the Cursor fallback: when the Cursor dashboard API path fails,
 * tokscale's local Cursor cache (populated only if the user ran `tokscale cursor
 * sync` themselves) is read through the same graph call.
 *
 * Always run with `--offline`: local data + cached pricing, no network request.
 */

/**
 * tokscale client id → the `tool` id we submit. Only agents that keep usage in a
 * LOCAL store and that no other reader in this CLI covers. Two clients may map
 * to one tool (Devin's CLI and desktop app are one product on the board).
 */
export const TOKSCALE_EXTRA_CLIENTS: Readonly<Record<string, string>> = {
  "devin-cli": "devin",
  "devin-desktop": "devin",
  zed: "zed",
  kiro: "kiro",
  crush: "crush",
  augment: "augment",
  junie: "junie",
  qoder: "qoder",
  mux: "mux",
  jcode: "jcode",
  commandcode: "commandcode",
  micode: "mimo",
  "micode-desktop": "mimo",
  codebuddy: "codebuddy",
  workbuddy: "workbuddy",
  opencodereview: "opencodereview",
  gjc: "gajae",
  kimchi: "kimchi",
  reasonix: "reasonix",
  "prime-agent": "prime",
  freebuff: "freebuff",
  mcode: "mcode",
  fx: "fx",
  omp: "omp",
  senpi: "senpi",
  muse: "muse",
  aside: "aside",
  vibe: "vibe",
  proma: "proma",
  bb: "bb",
};

/**
 * tokscale clients we never take, and why. Kept as data so a test can prove the
 * two lists are disjoint and that every one of tokscale's clients was decided.
 */
export const TOKSCALE_EXCLUDED_CLIENTS: Readonly<Record<string, string>> = {
  // Already read by ccusage (SOURCES in collect.ts) — taking them twice doubles the day.
  claude: "ccusage/native",
  codex: "ccusage/native",
  gemini: "ccusage",
  copilot: "ccusage",
  opencode: "ccusage",
  amp: "ccusage",
  droid: "ccusage",
  goose: "ccusage",
  kimi: "ccusage",
  qwen: "ccusage",
  kilo: "ccusage",
  kilocode: "ccusage (kilo)",
  openclaw: "ccusage",
  hermes: "ccusage",
  pi: "ccusage",
  codebuff: "ccusage",
  antigravity: "ccusage",
  "antigravity-cli": "ccusage (antigravity)",
  "antigravity-extension": "ccusage (antigravity) — same conversations dir",
  grok: "ccusage",
  zcode: "ccusage",
  // DeepSeek Harness: ccusage reads it from 20.1 (not yet past our 7-day
  // release-age rule). Left out so that bump can't double-count it.
  dsh: "ccusage from 20.1",
  // Read by our own native readers.
  cline: "native vscode-agents",
  roocode: "native vscode-agents",
  cursor: "cursor.ts (tokscale only as its fallback)",
  // Not a local record: caches tokscale fills from a vendor API after its own login.
  trae: "remote API cache",
  warp: "remote API cache",
  capy: "cloud agent / remote API cache",
  // Not coding-agent usage, or would double-count another agent's traffic.
  "9router": "proxy — re-counts other agents' requests",
  synthetic: "inference provider, not an agent",
  hindsight: "memory backend, not an agent",
  lmstudio: "local model server, not an agent",
  unsloth: "local model studio, not an agent",
  cherrystudio: "general chat app",
};

/** Bound on one tokscale run (it reads every selected client in one pass). */
export const TOKSCALE_TIMEOUT_MS = 60_000;
const TOKSCALE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function numCost(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Map a `tokscale graph` report (`contributions[].clients[]`, one row per day ×
 * client × model) into daily entries. Pure + tested.
 *
 * - Only clients present in `clientMap` are kept: a tokscale release that starts
 *   returning an unselected client (or ignores `-c`) can never leak an
 *   already-counted agent into the payload.
 * - tokscale reports reasoning separately from output; our schema has no
 *   reasoning bucket, so it folds into output (as provider bills count it).
 * - Rows sharing (date, tool, model) are summed — two tokscale clients can map
 *   to one tool, and dedupeDaily would merge them anyway.
 * - A $0 cost (tokscale's offline price cache predates the model) is filled
 *   from our own price table, so the same model costs the same on the board
 *   whichever agent burned it. A positive tokscale cost is kept: some agents
 *   record the provider's actual charge.
 */
export function mapTokscaleGraph(
  json: unknown,
  clientMap: Readonly<Record<string, string>>,
  now: number = Date.now(),
): DailyUsageEntry[] {
  const days = (json as { contributions?: unknown } | null)?.contributions;
  if (!Array.isArray(days)) return [];
  const byKey = new Map<string, DailyUsageEntry>();
  for (const rawDay of days) {
    const day = rawDay as { date?: unknown; clients?: unknown } | null;
    if (!day || typeof day.date !== "string" || !plausibleUsageDate(day.date, now))
      continue;
    if (!Array.isArray(day.clients)) continue;
    for (const rawRow of day.clients) {
      const row = rawRow as Record<string, unknown> | null;
      if (!row || typeof row.client !== "string") continue;
      if (!Object.prototype.hasOwnProperty.call(clientMap, row.client)) continue;
      const tool = clientMap[row.client]!;
      const tokens = (row.tokens ?? {}) as Record<string, unknown>;
      const inputTokens = num(tokens.input);
      const outputTokens = num(tokens.output) + num(tokens.reasoning);
      const cacheCreationTokens = num(tokens.cacheWrite);
      const cacheReadTokens = num(tokens.cacheRead);
      const costUSD = numCost(row.cost);
      if (
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0 &&
        costUSD === 0
      )
        continue;
      const model =
        typeof row.modelId === "string" && row.modelId.trim() ? row.modelId.trim() : tool;
      const key = `${day.date}|${tool}|${model}`;
      const prev = byKey.get(key);
      if (prev) {
        prev.inputTokens += inputTokens;
        prev.outputTokens += outputTokens;
        prev.cacheCreationTokens += cacheCreationTokens;
        prev.cacheReadTokens += cacheReadTokens;
        prev.costUSD = Number((prev.costUSD + costUSD).toFixed(6));
        continue;
      }
      byKey.set(key, {
        date: day.date,
        tool,
        model,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUSD: Number(costUSD.toFixed(6)),
        origin: "cli",
        verified: false,
      });
    }
  }
  return [...byKey.values()].map((e) =>
    e.costUSD > 0 ? e : { ...e, costUSD: estimateCostUSD(e.model, e) },
  );
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

/**
 * Environment for a tokscale child: never phone home, never start its own
 * scheduler. (`--offline` already blocks network use; these are belt and braces.)
 */
export function tokscaleEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    DO_NOT_TRACK: "1",
    TOKSCALE_AUTOSUBMIT_SKIP_SCHEDULER: "1",
    NO_COLOR: "1",
  };
}

export interface TokscaleGraphResult {
  entries: DailyUsageEntry[];
  /** tokscale was installed and answered with a readable report. */
  ran: boolean;
  /** The run was killed by our timeout (a partial scan; nothing was taken). */
  timedOut: boolean;
}

export interface RunTokscaleGraphOpts {
  clientMap: Readonly<Record<string, string>>;
  bin?: { cmd: string; prefixArgs: string[] } | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/** One `tokscale graph --offline -c <clients>` pass, mapped to daily entries. */
export async function runTokscaleGraph(
  opts: RunTokscaleGraphOpts,
): Promise<TokscaleGraphResult> {
  const bin = opts.bin === undefined ? resolveTokscaleBin() : opts.bin;
  const clients = Object.keys(opts.clientMap);
  if (!bin || clients.length === 0) return { entries: [], ran: false, timedOut: false };
  try {
    const { stdout } = await execFileAsync(
      bin.cmd,
      [
        ...bin.prefixArgs,
        "graph",
        "--offline",
        "--no-spinner",
        "--client",
        clients.join(","),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: TOKSCALE_MAX_BUFFER_BYTES,
        timeout: opts.timeoutMs ?? TOKSCALE_TIMEOUT_MS,
        env: tokscaleEnv(opts.env),
      },
    );
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      return { entries: [], ran: false, timedOut: false };
    }
    return {
      entries: mapTokscaleGraph(json, opts.clientMap, opts.now),
      ran: true,
      timedOut: false,
    };
  } catch (err) {
    const e = err as { killed?: boolean };
    return { entries: [], ran: false, timedOut: e.killed === true };
  }
}

/**
 * Usage from every agent only tokscale can read (Devin, Zed, Kiro, …). A no-op
 * (`ran:false`) when tokscale isn't installed on this platform.
 */
export function collectTokscaleExtras(
  opts: Omit<RunTokscaleGraphOpts, "clientMap"> = {},
): Promise<TokscaleGraphResult> {
  return runTokscaleGraph({ ...opts, clientMap: TOKSCALE_EXTRA_CLIENTS });
}

/**
 * Cursor fallback: tokscale's locally synced Cursor cache, in one graph call
 * (previously one spawn per day for 30 days). Empty unless the user has run
 * `tokscale cursor login` + `sync` on this machine.
 */
export async function collectCursorViaTokscale(
  opts: Omit<RunTokscaleGraphOpts, "clientMap"> = {},
): Promise<DailyUsageEntry[]> {
  const res = await runTokscaleGraph({ ...opts, clientMap: { cursor: "cursor" } });
  return res.entries;
}
