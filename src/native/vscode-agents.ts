/**
 * Native reader for the Cline-lineage VS Code agents (Cline, Roo Code).
 *
 * Why this exists: `ccusage` can't see these agents — they don't write ccusage's
 * JSONL logs. Instead they persist each task under the editor's globalStorage as
 * `.../globalStorage/<extension-id>/tasks/<taskId>/ui_messages.json`, a JSON
 * array of UI messages. Every provider request appears as a `say:"api_req_started"`
 * row whose `text` is a small JSON blob; Cline writes the row when the request
 * starts (text = just the request) and UPDATES the same row in place with the
 * real `tokensIn/tokensOut/cacheWrites/cacheReads/cost` when it finishes. So a
 * finished request carries the token totals, and counting those rows gives us
 * both the usage and a natural anti-fraud fingerprint (one real provider request
 * each) — the same `requestCount` signal the Claude/Codex native readers emit.
 *
 * Kilo Code shares this exact task layout but is already read by `ccusage kilo`,
 * so it is deliberately NOT included here (double-counting guard).
 *
 * Purely additive + best-effort: when the agent isn't installed there are no
 * task dirs and the reader returns `found:false`, changing nothing. Model name:
 * Cline records it on the message row as `modelInfo.modelId`, which we use; Roo
 * doesn't put a model in `ui_messages.json` at all, so its rows fall back to the
 * tool id (e.g. "roo"). Field names verified against the Cline (`ClineApiReqInfo`)
 * and Roo (`ParsedApiReqStartedTextType`) source.
 *
 * Split into a PURE core (`aggregateVscodeAgentEntries`) the unit tests drive
 * with fixtures, and a thin filesystem wrapper (`collectVscodeAgent`) that reuses
 * the shared per-file cache for incremental reads.
 */
import { readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";
import type { NativeCollectResult } from "./claude.js";
import { NATIVE_READ_BUDGET_MS } from "./claude.js";
import { nativeCachePath, readFilesWithCache } from "./file-cache.js";
import { localUsageDate } from "./usage-date.js";

/** Known Cline-lineage agents that use the globalStorage `tasks/*` layout. */
export interface VscodeAgent {
  /** The `tool` id that lands in the payload / on the leaderboard. */
  tool: string;
  /** VS Code extension folder id(s) under `globalStorage`. */
  extIds: string[];
}

/** Cline and Roo Code. (Kilo shares the layout but is read by `ccusage kilo`.) */
export const VSCODE_AGENTS: VscodeAgent[] = [
  { tool: "cline", extIds: ["saoudrizwan.claude-dev"] },
  { tool: "roo", extIds: ["rooveterinaryinc.roo-cline"] },
];

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

interface ParsedRequest {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Cost Cline recorded for the request, or null to fall back to estimation. */
  storedCost: number | null;
}

/**
 * Parse one `api_req_started` UI message into a request, or null if it isn't a
 * finished request (no token fields yet) or is malformed. `text` may be a JSON
 * string (the common case) or an already-parsed object (some forks/versions).
 */
function parseApiReqMessage(
  tool: string,
  msg: Record<string, unknown>,
): ParsedRequest | null {
  if (msg.say !== "api_req_started") return null;
  const date = localUsageDate(Number(msg.ts));
  if (!date) return null;

  let payload: Record<string, unknown> | null = null;
  const text = msg.text;
  if (typeof text === "string") {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null; // corrupt blob — skip
    }
  } else if (text && typeof text === "object") {
    payload = text as Record<string, unknown>;
  }
  if (!payload) return null;

  const inputTokens = num(payload.tokensIn);
  const outputTokens = num(payload.tokensOut);
  const cacheCreationTokens = num(payload.cacheWrites);
  const cacheReadTokens = num(payload.cacheReads);
  // A started-but-not-finished request carries only `request`, no token fields.
  if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0)
    return null;

  // Model resolution: Cline records it on the message ROW as
  // `modelInfo.modelId` (never inside the api_req_started text). Roo records it
  // nowhere in ui_messages.json, so it falls back to the tool id. We also honor a
  // `text.model` if a fork ever adds one, then the tool id as a last resort.
  const modelInfo = msg.modelInfo as Record<string, unknown> | undefined;
  const modelFromRow =
    modelInfo && typeof modelInfo === "object" && typeof modelInfo.modelId === "string" && modelInfo.modelId
      ? modelInfo.modelId
      : null;
  const modelFromText =
    typeof payload.model === "string" && payload.model ? payload.model : null;

  const storedCostRaw = Number(payload.cost);
  return {
    date,
    model: modelFromRow ?? modelFromText ?? tool,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    storedCost: Number.isFinite(storedCostRaw) && storedCostRaw > 0 ? storedCostRaw : null,
  };
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

function bucketsToEntries(tool: string, buckets: Iterable<Bucket>): DailyUsageEntry[] {
  const entries: DailyUsageEntry[] = [];
  for (const b of buckets) {
    const tokens =
      b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens;
    if (tokens === 0) continue;
    entries.push({
      date: b.date,
      tool,
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

/**
 * PURE core: fold a task's UI messages into per-(date, model) daily entries.
 * Each finished `api_req_started` request contributes its tokens, a stored or
 * estimated cost, and one to the request fingerprint.
 */
export function aggregateVscodeAgentEntries(
  tool: string,
  messages: unknown[],
): DailyUsageEntry[] {
  const byKey = new Map<string, Bucket>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const req = parseApiReqMessage(tool, raw as Record<string, unknown>);
    if (!req) continue;
    const key = `${req.date}|${req.model}`;
    let b = byKey.get(key);
    if (!b) {
      b = {
        date: req.date,
        model: req.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0,
        requestCount: 0,
      };
      byKey.set(key, b);
    }
    b.inputTokens += req.inputTokens;
    b.outputTokens += req.outputTokens;
    b.cacheCreationTokens += req.cacheCreationTokens;
    b.cacheReadTokens += req.cacheReadTokens;
    b.costUSD +=
      req.storedCost ??
      estimateCostUSD(req.model, {
        inputTokens: req.inputTokens,
        outputTokens: req.outputTokens,
        cacheCreationTokens: req.cacheCreationTokens,
        cacheReadTokens: req.cacheReadTokens,
      });
    b.requestCount += 1;
  }
  return bucketsToEntries(tool, byKey.values());
}

/** Parse one `ui_messages.json` file body into daily entries (empty on garbage). */
export function parseVscodeAgentMessages(tool: string, raw: string): DailyUsageEntry[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return aggregateVscodeAgentEntries(tool, arr);
}

/**
 * The editor globalStorage roots to scan, across the common VS Code family
 * (stable, Insiders, Cursor, VSCodium, Windsurf) and platforms. Best-effort: a
 * root that doesn't exist simply yields no task dirs.
 */
export function vscodeGlobalStorageRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const apps = ["Code", "Code - Insiders", "Cursor", "VSCodium", "Windsurf"];
  const home = env.HOME || homedir();
  const os = platform();
  const base = (app: string): string =>
    os === "darwin"
      ? join(home, "Library", "Application Support", app, "User", "globalStorage")
      : os === "win32"
        ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), app, "User", "globalStorage")
        : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), app, "User", "globalStorage");
  return apps.map(base);
}

/** List each `<root>/<extId>/tasks/<taskId>/ui_messages.json` file present. */
async function listTaskFiles(
  roots: string[],
  extIds: string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    for (const extId of extIds) {
      const tasksDir = join(root, extId, "tasks");
      let taskDirs: string[];
      try {
        const dirents = await readdir(tasksDir, { withFileTypes: true });
        taskDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        continue; // extension/tasks dir absent — skip
      }
      for (const t of taskDirs) files.push(join(tasksDir, t, "ui_messages.json"));
    }
  }
  return files;
}

/** Bump when the parse/aggregate semantics change — invalidates the per-file cache. */
export const VSCODE_CACHE_VERSION = 2;

// Compact per-file cache row: [date, model, in, out, cacheCreate, cacheRead, cost, requestCount].
type CachedRow = [string, string, number, number, number, number, number, number];

function entryToRow(e: DailyUsageEntry): CachedRow {
  return [
    e.date,
    e.model,
    e.inputTokens,
    e.outputTokens,
    e.cacheCreationTokens,
    e.cacheReadTokens,
    e.costUSD,
    e.requestCount ?? 0,
  ];
}

export interface CollectVscodeAgentOpts {
  tool: string;
  extIds: string[];
  roots?: string[];
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  now?: () => number;
  cachePath?: string;
}

/**
 * Read every task file for one agent and aggregate it. Best-effort and
 * time-bounded like the other native readers: missing dirs / unreadable files
 * are skipped, `found:false` when nothing is on disk (clean no-op), and on a
 * budget timeout it bows out with `timedOut:true` rather than submitting a
 * partial corpus. Reuses the shared per-file cache — task files are rewritten
 * only while their task is active, so steady state reads just today's tasks.
 */
export async function collectVscodeAgent(
  opts: CollectVscodeAgentOpts,
): Promise<NativeCollectResult> {
  const env = opts.env ?? process.env;
  const roots = opts.roots ?? vscodeGlobalStorageRoots(env);
  const files = await listTaskFiles(roots, opts.extIds);
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const now = opts.now ?? Date.now;
  const res = await readFilesWithCache<CachedRow>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath(`vscode-${opts.tool}`, env),
    version: VSCODE_CACHE_VERSION,
    parseFile: (content) => parseVscodeAgentMessages(opts.tool, content).map(entryToRow),
    deadline: now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS),
    now,
  });
  if (!res.itemsByFile) {
    return { entries: [], found: false, filesScanned: res.filesRead, timedOut: true };
  }

  // Merge rows across task files, summing any that share (date, model).
  const byKey = new Map<string, Bucket>();
  for (const rows of res.itemsByFile) {
    for (const r of rows) {
      const key = `${r[0]}|${r[1]}`;
      let b = byKey.get(key);
      if (!b) {
        b = {
          date: r[0],
          model: r[1],
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUSD: 0,
          requestCount: 0,
        };
        byKey.set(key, b);
      }
      b.inputTokens += r[2];
      b.outputTokens += r[3];
      b.cacheCreationTokens += r[4];
      b.cacheReadTokens += r[5];
      b.costUSD += r[6];
      b.requestCount += r[7];
    }
  }
  return {
    entries: bucketsToEntries(opts.tool, byKey.values()),
    found: true,
    filesScanned: res.filesRead,
  };
}
