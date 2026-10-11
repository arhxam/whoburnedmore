/**
 * Native reader for DeepSeek Harness.
 *
 * The harness logs each session to
 * `~/.dsh/sessions/<workspace>/session-<id>/session.v<N>.jsonl.zstd`: JSON
 * lines, compressed as a run of zstd frames (one per flush). Every
 * `assistant/message` event carries the provider's token usage for that one
 * request, so these are real per-request numbers, not estimates. `ccusage` has
 * no DeepSeek Harness source, so we read the log ourselves.
 *
 * zstd comes from the decoder built into Node 22.15+. On older Node the reader
 * returns `found:false` rather than pulling in a dependency.
 *
 * Split like the Continue reader: a PURE core (`mapDeepseekRequests`,
 * `parseDeepseekSession`) the tests drive with fixtures, and a filesystem
 * wrapper (`collectDeepseek`) on the shared per-file cache.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type { DailyUsageEntry } from "./shared.js";
import type { NativeCollectResult } from "./native/claude.js";
import { NATIVE_READ_BUDGET_MS } from "./native/claude.js";
import {
  MAX_NATIVE_FILE_BYTES,
  nativeCachePath,
  readFilesWithCache,
} from "./native/file-cache.js";
import { localUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";

type ZstdDecompressSync = (
  input: Buffer,
  options: { info: true; maxOutputLength: number },
) => { buffer: Buffer; engine: { bytesWritten: number } };

// Looked up at runtime: a named import would fail to link on Node 20.
const zstdDecompressSync = (zlib as { zstdDecompressSync?: unknown })
  .zstdDecompressSync as ZstdDecompressSync | undefined;

/** False on Node versions without a built-in zstd decoder. */
export const DEEPSEEK_ZSTD_AVAILABLE = typeof zstdDecompressSync === "function";

/** Ceiling on one session's decompressed size, so a hostile file cannot exhaust memory. */
const MAX_DECODED_BYTES = 16 * MAX_NATIVE_FILE_BYTES;

const SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/;

/** One provider request: [id, date, model, input, output, cacheWrite, cacheRead]. */
export type DeepseekRequest = [string, string, string, number, number, number, number];

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Decompress a run of zstd frames and hand back the complete lines. A frame
 * that fails to decode (the harness is mid-write) ends the read; the lines
 * before it are kept. Returns null when the output crosses the size ceiling.
 */
function decodeLines(bytes: Buffer): string[] | null {
  if (!zstdDecompressSync) return [];
  const lines: string[] = [];
  let carry: Buffer = Buffer.alloc(0);
  let offset = 0;
  let decoded = 0;
  while (offset < bytes.length) {
    let frame: Buffer;
    try {
      const res = zstdDecompressSync(bytes.subarray(offset), {
        info: true,
        maxOutputLength: MAX_NATIVE_FILE_BYTES,
      });
      if (!(res.engine.bytesWritten > 0)) break;
      offset += res.engine.bytesWritten;
      frame = res.buffer;
    } catch {
      break;
    }
    decoded += frame.length;
    if (decoded > MAX_DECODED_BYTES) return null;
    const chunk = carry.length > 0 ? Buffer.concat([carry, frame]) : frame;
    const end = chunk.lastIndexOf(0x0a);
    if (end === -1) {
      carry = chunk;
      continue;
    }
    lines.push(...chunk.subarray(0, end).toString("utf8").split("\n"));
    carry = chunk.subarray(end + 1);
  }
  return lines;
}

/**
 * PURE core: parse one session file's bytes into its usage-bearing requests.
 * `path` scopes the fallback id of a message that carries none.
 */
export function parseDeepseekSession(bytes: Buffer, path: string): DeepseekRequest[] {
  const requests: DeepseekRequest[] = [];
  for (const line of decodeLines(bytes) ?? []) {
    if (!line.includes('"assistant/message"')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!event || event.type !== "assistant/message") continue;
    const data = event.data as Record<string, unknown> | undefined;
    const usage = data?.usage as Record<string, unknown> | undefined;
    const message = data?.message as Record<string, unknown> | undefined;
    const source = message?.source as Record<string, unknown> | undefined;
    if (!usage || typeof source?.model !== "string" || !source.model) continue;
    const date = typeof event.time === "number" ? localUsageDate(event.time) : null;
    if (!date) continue;
    const input = num(usage.inputTokens);
    const output = num(usage.outputTokens);
    const cacheWrite = num(usage.cacheWriteTokens);
    const cacheRead = num(usage.cacheReadTokens);
    if (input + output + cacheWrite + cacheRead === 0) continue;
    const id =
      typeof message?.id === "string" && message.id
        ? message.id
        : `${path}#${String(event.seq)}`;
    requests.push([id, date, source.model, input, output, cacheWrite, cacheRead]);
  }
  return requests;
}

/**
 * PURE core: fold requests into per-(date, model) daily entries tagged tool
 * "deepseek". A message id seen more than once (a session seeded from another)
 * counts once, keeping the occurrence with the most tokens.
 */
export function mapDeepseekRequests(requests: DeepseekRequest[]): DailyUsageEntry[] {
  const tokens = (r: DeepseekRequest) => r[3] + r[4] + r[5] + r[6];
  const byId = new Map<string, DeepseekRequest>();
  for (const r of requests) {
    const seen = byId.get(r[0]);
    if (!seen || tokens(r) > tokens(seen)) byId.set(r[0], r);
  }

  const byKey = new Map<string, DailyUsageEntry>();
  for (const [, date, model, input, output, cacheWrite, cacheRead] of byId.values()) {
    const key = `${date}|${model}`;
    let e = byKey.get(key);
    if (!e) {
      e = {
        date,
        tool: "deepseek",
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0,
        origin: "cli",
        verified: false,
        requestCount: 0,
      };
      byKey.set(key, e);
    }
    e.inputTokens += input;
    e.outputTokens += output;
    e.cacheCreationTokens += cacheWrite;
    e.cacheReadTokens += cacheRead;
    e.requestCount = (e.requestCount ?? 0) + 1;
  }
  for (const e of byKey.values()) e.costUSD = estimateCostUSD(e.model, e);
  return [...byKey.values()];
}

/** Find session logs under `root`, bounded in depth, count and time. */
async function listSessionFiles(
  root: string,
  opts: { deadline: number; now: () => number; maxFiles: number },
): Promise<string[] | null> {
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    if (opts.now() > opts.deadline) return null;
    let dirents;
    try {
      dirents = await readdir(queue[i].dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = join(queue[i].dir, d.name);
      if (d.isDirectory()) {
        if (queue[i].depth < 4) queue.push({ dir: full, depth: queue[i].depth + 1 });
      } else if (d.isFile() && SESSION_FILE.test(d.name)) {
        files.push(full);
        if (files.length > opts.maxFiles) return null;
      }
    }
  }
  return files;
}

/** Bump when the parse semantics change; invalidates the per-file cache. */
export const DEEPSEEK_CACHE_VERSION = 1;

export interface CollectDeepseekOpts {
  /** Harness home dir (default `~/.dsh`); the reader scans `<dir>/sessions`. */
  dshDir?: string;
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  now?: () => number;
  cachePath?: string;
  maxFiles?: number;
}

/**
 * Read every DeepSeek Harness session log and aggregate it. Best-effort and
 * time-bounded like the other native readers: `found:false` when the harness
 * is not installed or this Node cannot decode zstd, `timedOut:true` on a budget
 * timeout rather than submitting a partial corpus.
 */
export async function collectDeepseek(
  opts: CollectDeepseekOpts = {},
): Promise<NativeCollectResult> {
  if (!DEEPSEEK_ZSTD_AVAILABLE) return { entries: [], found: false, filesScanned: 0 };
  const env = opts.env ?? process.env;
  const home = opts.dshDir ?? join(env.HOME || homedir(), ".dsh");
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const files = await listSessionFiles(join(home, "sessions"), {
    deadline,
    now,
    maxFiles: Math.max(1, opts.maxFiles ?? 10_000),
  });
  if (!files) return { entries: [], found: false, filesScanned: 0, timedOut: true };
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const res = await readFilesWithCache<DeepseekRequest>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("deepseek", env),
    version: DEEPSEEK_CACHE_VERSION,
    encoding: "latin1",
    parseFile: (content, path) =>
      parseDeepseekSession(Buffer.from(content, "latin1"), path),
    deadline,
    now,
  });
  if (!res.itemsByFile) {
    return { entries: [], found: false, filesScanned: res.filesRead, timedOut: true };
  }
  return {
    entries: mapDeepseekRequests(res.itemsByFile.flat()),
    found: true,
    filesScanned: res.filesRead,
  };
}
