/**
 * Native reader for Devin (Cognition) — the CLI and the desktop app's local
 * sessions.
 *
 * Devin keeps local sessions in one of two stores, chosen by `session_store` in
 * `~/.config/devin/config.json` (verified against Devin CLI 3000.15.14 by
 * driving the real binary, 2026-11-28):
 *
 *  - `"sqlite"` (the default): `<cli_root>/sessions.db`, table `message_nodes`
 *    (one JSON `chat_message` per row). Read through tokscale (collect.ts),
 *    which de-duplicates repeated request ids and is repriced by our table.
 *  - `"files"`: one directory per session, `<cli_root>/sessions/<id>/
 *    {meta.json, log.jsonl, window_tools.json}`. Read here. Switching to files
 *    imports the SQLite sessions into this store, so the two never need merging.
 *
 * `<cli_root>` is `$DEVIN_SESSIONS_DIR/cli` when that override is set, else
 * `$XDG_DATA_HOME/devin/cli` (default `~/.local/share/devin/cli`, macOS too).
 *
 * `log.jsonl` is an append-only event stream; `kind:"node"` records carry chat
 * nodes, and an assistant node's `message.metadata` holds the request's exact
 * usage (the same JSON the SQLite store keeps in `chat_message`):
 *
 *   { "kind":"node", "at":1793846478, "node": { "id":12, "parent_id":11,
 *     "metadata":{…}, "message": { "message_id":"…", "role":"assistant",
 *       "metadata": { "request_id":"…", "generation_model":"claude-opus-5-5-medium",
 *         "created_at":"2026-11-05T02:41:18Z",
 *         "metrics": { "input_tokens":355, "output_tokens":229,
 *                      "cache_read_tokens":13933, "cache_creation_tokens":11563 } } } } }
 *
 * `input_tokens` excludes cache reads/writes (they sum to
 * `context_input_tokens`), matching our schema directly. Devin Desktop runs its
 * local sessions through the same CLI store, so this one reader covers both.
 * Cloud ("devin-cloud") sessions keep no local token record and can't be read.
 *
 * Two duplication traps, both handled per file (one file = one session):
 *  - the same `node.id` is re-appended as the node updates → the LAST record
 *    for an id wins;
 *  - Devin copies whole message chains under NEW node ids when the system
 *    prefix changes (`compact/prior_node_ids`), so distinct node ids repeat one
 *    API request → each `request_id` counts once (node id is the key only when a
 *    record has no request id).
 */
import { lstat, readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";
import type { NativeCollectResult } from "./claude.js";
import { NATIVE_READ_BUDGET_MS } from "./claude.js";
import { nativeCachePath, readFilesWithCache } from "./file-cache.js";
import { readJsonlStream } from "./jsonl-stream.js";
import { localUsageDate } from "./usage-date.js";

export const DEVIN_TOOL = "devin";

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Devin routing modes / composite Fusion profiles are not real model ids. */
export function isDevinRoutingMode(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "adaptive" || m === "fusion" || m.startsWith("fusion-");
}

/** `at` / `created_at` → epoch ms. Accepts ISO strings, seconds, or ms. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n >= 1e12 ? n : n * 1000;
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value >= 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  return null;
}

interface ParsedRequest {
  key: string;
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Parse one `log.jsonl` record into a usage request for its node, `null` when
 * the record is a node WITHOUT usage (it still supersedes an earlier version of
 * that node), or `undefined` when the line isn't a node record at all.
 */
export function parseDevinLogRecord(
  line: string,
  now: number = Date.now(),
): { nodeId: string; request: ParsedRequest | null } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let rec: unknown;
  try {
    rec = JSON.parse(trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed);
  } catch {
    return undefined;
  }
  if (!rec || typeof rec !== "object") return undefined;
  const r = rec as Record<string, unknown>;
  if (r.kind !== "node") return undefined;
  const node = r.node as Record<string, unknown> | null | undefined;
  if (!node || typeof node !== "object") return undefined;
  const id = node.id;
  if (typeof id !== "number" && typeof id !== "string") return undefined;
  const nodeId = String(id);

  const message = node.message as Record<string, unknown> | null | undefined;
  if (!message || typeof message !== "object" || message.role !== "assistant")
    return { nodeId, request: null };
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const metrics = (meta.metrics ?? {}) as Record<string, unknown>;

  let inputTokens = num(metrics.input_tokens);
  let outputTokens = num(metrics.output_tokens);
  const cacheReadTokens = num(metrics.cache_read_tokens);
  const cacheCreationTokens = num(metrics.cache_creation_tokens);
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) {
    // No metrics block: an older record may still carry a bare token count.
    outputTokens = num(meta.num_tokens);
    inputTokens = 0;
    if (outputTokens === 0) return { nodeId, request: null };
  }

  // Prefer the message's own completion time over the append time, so a later
  // re-append of the node can't move it to another day.
  const ms = toEpochMs(meta.created_at) ?? toEpochMs(r.at);
  const date = ms === null ? null : localUsageDate(ms, now);
  if (!date) return { nodeId, request: null };

  const rawModel =
    typeof meta.generation_model === "string" ? meta.generation_model.trim() : "";
  const model = rawModel && !isDevinRoutingMode(rawModel) ? rawModel : DEVIN_TOOL;
  const requestId = typeof meta.request_id === "string" ? meta.request_id.trim() : "";

  return {
    nodeId,
    request: {
      key: requestId ? `request:${requestId}` : `node:${nodeId}`,
      date,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    },
  };
}

// Compact cached row: [date, model, in, out, cacheCreate, cacheRead, cost, requestCount].
export type DevinRow = [string, string, number, number, number, number, number, number];

/** Collapse one session's node records (in file order) into per-(date, model) rows. */
export function aggregateDevinSession(
  records: Iterable<{ nodeId: string; request: ParsedRequest | null }>,
): DevinRow[] {
  // Last record per node wins (append-only updates).
  const latest = new Map<string, ParsedRequest | null>();
  for (const r of records) {
    latest.delete(r.nodeId); // keep insertion order = order of final appearance
    latest.set(r.nodeId, r.request);
  }
  const seenRequests = new Set<string>();
  const buckets = new Map<string, DevinRow>();
  for (const req of latest.values()) {
    if (!req || seenRequests.has(req.key)) continue;
    seenRequests.add(req.key);
    const k = `${req.date}|${req.model}`;
    const row = buckets.get(k) ?? [req.date, req.model, 0, 0, 0, 0, 0, 0];
    row[2] += req.inputTokens;
    row[3] += req.outputTokens;
    row[4] += req.cacheCreationTokens;
    row[5] += req.cacheReadTokens;
    row[7] += 1;
    buckets.set(k, row);
  }
  for (const row of buckets.values()) {
    row[6] = estimateCostUSD(row[1], {
      inputTokens: row[2],
      outputTokens: row[3],
      cacheCreationTokens: row[4],
      cacheReadTokens: row[5],
    });
  }
  return [...buckets.values()];
}

/** Parse a whole `log.jsonl` body (tests and small files). */
export function parseDevinSessionLog(content: string, now: number = Date.now()): DevinRow[] {
  const records: Array<{ nodeId: string; request: ParsedRequest | null }> = [];
  for (const line of content.split("\n")) {
    const r = parseDevinLogRecord(line, now);
    if (r) records.push(r);
  }
  return aggregateDevinSession(records);
}

/**
 * Devin CLI roots for this user (any may be missing). `DEVIN_SESSIONS_DIR`
 * replaces the data root outright (Devin then writes `<dir>/cli/…` and nothing
 * under the default), so it is the only root when set. It only reaches us when
 * the variable is in this process's environment, i.e. interactive runs.
 */
export function devinCliRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.DEVIN_SESSIONS_DIR?.trim();
  if (override) return [join(override, "cli")];
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "devin", "cli"),
  ];
  if (platform() === "win32") {
    roots.unshift(join(env.APPDATA ?? join(home, "AppData", "Roaming"), "devin", "cli"));
  }
  return [...new Set(roots)];
}

/** Every `<root>/sessions/<id>/log.jsonl` present. */
export async function listDevinSessionLogs(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    const sessionsDir = join(root, "sessions");
    let dirs: string[];
    try {
      dirs = (await readdir(sessionsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const log = join(sessionsDir, d, "log.jsonl");
      // Only real files: in streaming mode the cache treats a listed path that
      // can't be stat'ed as an incomplete scan, so a session directory whose log
      // isn't written yet would otherwise disable the reader on every run.
      try {
        if ((await lstat(log)).isFile()) files.push(log);
      } catch {
        /* no log yet */
      }
    }
  }
  return files;
}

/** Bump when parse/aggregate semantics change — invalidates the per-file cache. */
export const DEVIN_CACHE_VERSION = 1;

export interface CollectDevinOpts {
  roots?: string[];
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  now?: () => number;
  cachePath?: string;
}

/**
 * Read every Devin session log. `found:false` when no session directory exists
 * (clean no-op), `timedOut:true` when the budget ran out — never a partial
 * corpus, since the server overwrites a day with whatever is submitted.
 */
export async function collectDevinNative(
  opts: CollectDevinOpts = {},
): Promise<NativeCollectResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const files = await listDevinSessionLogs(opts.roots ?? devinCliRoots(env));
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const res = await readFilesWithCache<DevinRow>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("devin", env),
    version: DEVIN_CACHE_VERSION,
    parseFile: (content) => parseDevinSessionLog(content, now()),
    // Session logs carry tool output and can outgrow the text cap; stream them.
    streamFile: async (path) => {
      const records: Array<{ nodeId: string; request: ParsedRequest | null }> = [];
      const at = now();
      const read = await readJsonlStream(
        path,
        (line) => {
          const r = parseDevinLogRecord(line, at);
          if (r) records.push(r);
        },
        { deadline, now },
      );
      return read.ok ? { ok: true, items: aggregateDevinSession(records) } : read;
    },
    deadline,
    now,
  });
  if (!res.itemsByFile) {
    return { entries: [], found: true, filesScanned: res.filesRead, timedOut: true };
  }

  const byKey = new Map<string, DevinRow>();
  for (const rows of res.itemsByFile) {
    for (const r of rows) {
      const k = `${r[0]}|${r[1]}`;
      const acc = byKey.get(k) ?? [r[0], r[1], 0, 0, 0, 0, 0, 0];
      for (let i = 2; i < 8; i++) (acc[i] as number) += r[i] as number;
      byKey.set(k, acc);
    }
  }
  const entries: DailyUsageEntry[] = [...byKey.values()]
    .filter((r) => r[2] + r[3] + r[4] + r[5] > 0)
    .map((r) => ({
      date: r[0],
      tool: DEVIN_TOOL,
      model: r[1],
      inputTokens: r[2],
      outputTokens: r[3],
      cacheCreationTokens: r[4],
      cacheReadTokens: r[5],
      costUSD: Number(r[6].toFixed(6)),
      origin: "cli",
      verified: false,
      requestCount: r[7],
    }));
  return {
    entries,
    found: true,
    filesScanned: res.filesRead,
    ...(res.permissionDenied ? { permissionDenied: res.permissionDenied } : {}),
  };
}
