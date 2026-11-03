/**
 * Persistent per-file parse cache for the native readers.
 *
 * Why this exists: both native readers (claude.ts, codex.ts) re-read and
 * re-parse the ENTIRE on-disk transcript corpus on every run. That corpus grows
 * without bound (a heavy user's is multiple GB), while the read budget is a
 * fixed wall clock — and the 15-minute background sync runs at launchd
 * `Background` priority, where macOS throttles CPU/IO several-fold. Once the
 * corpus outgrows the budget, EVERY sync abandons the read (`found:false`), the
 * ccusage fallback usually times out too, and the source silently drops out of
 * the payload run after run: the user's day-rows are born hours or days late
 * and they vanish from the daily leaderboard while visibly burning. (Measured
 * live 2026-07-17: 42% of listed users' day-rows were first inserted AFTER the
 * local day had ended.)
 *
 * The fix: transcripts are append-only and immutable once a session ends, so we
 * cache each file's PARSED items keyed by (size, mtime) in the CLI config dir.
 * A run then stats everything but reads only new/changed files — steady state
 * is "today's active sessions", seconds even under background throttling.
 *
 * Two properties the readers rely on:
 *  - Items are cached PER FILE, before any cross-file merge, so claude's
 *    cross-file dedup (forked sessions duplicate (messageId,requestId) pairs)
 *    still sees every file's requests and keeps its max-wins semantics.
 *  - On budget exhaustion the progress so far is PERSISTED before bailing, so a
 *    corpus too large for one tick is finished across ticks — the cold first
 *    pass converges instead of starving forever.
 */
import {
  chmodSync,
  constants,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { defaultConfigDir } from "../config.js";

interface CachedFile<T> {
  size: number;
  mtimeMs: number;
  items: T[];
  /** Permanent failure (permission denied or too large). Retained until size or mtime changes. */
  skipped?: true;
}

interface CacheShape<T> {
  v: number;
  files: Record<string, CachedFile<T>>;
}

/** One corrupt local agent file must not allocate the sidecar/CLI without bound. */
export const MAX_NATIVE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_CACHE_BYTES = 128 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export type CappedTextRead =
  | { ok: true; content: string }
  | { ok: false; reason: "unreadable" | "too-large" | "timed-out"; code?: string };

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function warnSkippedTranscript(path: string, reason: string): void {
  console.warn(
    `whoburnedmore: skipping transcript ${path} (${reason}). It stays skipped until its size or modification time changes.`,
  );
}

function warnIncomplete(path: string, reason: string): void {
  console.warn(
    `whoburnedmore: transcript scan incomplete at ${path} (${reason}). This reader's totals are not authoritative.`,
  );
}

function warnCacheTooLarge(path: string, bytes: number, maxBytes: number): void {
  console.warn(
    `whoburnedmore: not writing native cache ${path} (${bytes} bytes exceeds ${maxBytes} byte limit).`,
  );
}

/**
 * Owner-safe, symlink-refusing, bounded text read. Reads in chunks so a file
 * that grows after stat() still cannot cross the byte ceiling, and checks the
 * caller's wall-clock deadline between I/O operations.
 */
export async function readTextFileCapped(
  path: string,
  opts: {
    maxBytes?: number;
    deadline?: number;
    now?: () => number;
  } = {},
): Promise<CappedTextRead> {
  const maxBytes = Math.max(1, opts.maxBytes ?? MAX_NATIVE_FILE_BYTES);
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const now = opts.now ?? Date.now;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { ok: false, reason: "unreadable" };
    if (metadata.size > maxBytes) return { ok: false, reason: "too-large" };

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      if (now() > deadline) return { ok: false, reason: "timed-out" };
      // Leave room for one sentinel byte once the cap is reached. If a file
      // grew after stat(), that next byte detects it without unbounded growth.
      const allowance = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
      if (allowance <= 0) return { ok: false, reason: "too-large" };
      const chunk = Buffer.allocUnsafe(allowance);
      const { bytesRead } = await handle.read(chunk, 0, allowance, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return { ok: false, reason: "too-large" };
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { ok: true, content: Buffer.concat(chunks, total).toString("utf8") };
  } catch (err) {
    const code = errorCode(err);
    return code ? { ok: false, reason: "unreadable", code } : { ok: false, reason: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Resolve the on-disk cache path for a reader's cache inside the config dir.
 * Honors the caller's env object (the readers thread a test env through), then
 * the process default — so tests never touch the real config dir and the
 * background sync (which forwards WHOBURNEDMORE_CONFIG_DIR in its plist) shares
 * the cache with interactive runs.
 */
export function nativeCachePath(
  reader: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.WHOBURNEDMORE_CONFIG_DIR?.trim();
  const dir = override || defaultConfigDir();
  return join(dir, `native-cache-${reader}.json`);
}

function canonicalCache<T>(version: number, files: Record<string, CachedFile<T>>): string {
  return JSON.stringify({ v: version, files });
}

async function loadCache<T>(
  path: string,
  version: number,
  maxBytes: number,
): Promise<{ files: Record<string, CachedFile<T>>; canonical: string | null }> {
  try {
    const read = await readTextFileCapped(path, { maxBytes });
    if (!read.ok) return { files: {}, canonical: null };
    const parsed = JSON.parse(read.content) as CacheShape<T>;
    if (parsed && parsed.v === version && parsed.files && typeof parsed.files === "object") {
      return { files: parsed.files, canonical: canonicalCache(version, parsed.files) };
    }
  } catch {
    // Missing or corrupt cache: start over. Never fatal.
  }
  return { files: {}, canonical: null };
}

function saveCache<T>(
  path: string,
  version: number,
  files: Record<string, CachedFile<T>>,
  maxBytes: number,
  previousCanonical: string | null,
): void {
  const serialized = canonicalCache(version, files);
  // Steady-state runs rewrite an identical document. Skip the replace so a
  // warm cache does not bump mtime or race another writer for no change.
  if (previousCanonical !== null && previousCanonical === serialized) return;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) {
    warnCacheTooLarge(path, bytes, maxBytes);
    return;
  }
  let tmp: string | null = null;
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // Atomic replace: a crash mid-write must never leave a truncated JSON that
    // a later run would half-trust. rename() is atomic on the same volume.
    tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    writeFileSync(tmp, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Explicit chmod also repairs platforms/filesystems that ignored creation mode.
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    tmp = null;
  } catch {
    // Cache persistence is best-effort; the reader still returns correct data.
  } finally {
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup of a failed atomic write.
      }
    }
  }
}

type StreamRead<T> =
  | { ok: true; items: T[] }
  | { ok: false; reason: string; code?: string };

type FailureClass = "timeout" | "missing" | "permanent" | "fatal";

function classifyFailure(failure: { reason: string; code?: string }): FailureClass {
  if (failure.reason === "timed-out") return "timeout";
  if (failure.code === "ENOENT") return "missing";
  if (
    failure.reason === "too-large" ||
    failure.code === "EACCES" ||
    failure.code === "EPERM"
  ) {
    return "permanent";
  }
  return "fatal";
}

function failureFromThrow(err: unknown): { ok: false; reason: string; code?: string } {
  if (err instanceof Error && err.message.includes("memory budget")) {
    return { ok: false, reason: "too-large" };
  }
  const code = errorCode(err);
  return code ? { ok: false, reason: "unreadable", code } : { ok: false, reason: "unreadable" };
}

function permanentLabel(failure: { reason: string }): string {
  return failure.reason === "too-large" ? "too-large" : "permission denied";
}

export interface FileCacheResult<T> {
  /** Per-file item lists in input-file order, or null when the scan is not authoritative. */
  itemsByFile: T[][] | null;
  /** Files actually READ (parsed) this run — cache hits don't count. */
  filesRead: number;
  timedOut: boolean;
  /**
   * The scan must not be treated as complete. A non-streaming file was over the
   * byte cap or unreadable, or a streaming read hit an identity failure such as
   * a symlink. A single permanently bad streaming transcript does NOT set this:
   * it is cached as a skip so later runs keep using the native reader.
   */
  incomplete?: boolean;
}

function progressSnapshot<T>(
  cached: Record<string, CachedFile<T>>,
  fresh: Record<string, CachedFile<T>>,
  dropped: ReadonlySet<string>,
  omit?: string,
): Record<string, CachedFile<T>> {
  const progress = { ...cached, ...fresh };
  for (const key of dropped) delete progress[key];
  if (omit) delete progress[omit];
  return progress;
}

/**
 * Read `files` through the persistent per-file cache: reuse the cached parse for
 * files whose (size, mtime) are unchanged, re-parse the rest, persist progress
 * (even on timeout), and return every file's items for the caller to merge.
 *
 * The deadline is only consulted before actual file reads — stats and cache
 * hits are near-free. On timeout the entries parsed so far are SAVED and
 * `itemsByFile` is null: the caller keeps its established "abandon and fall
 * back" semantics (a partial corpus must never be submitted — recent days would
 * be $set to an undercount server-side), but the next run resumes from the
 * persisted progress instead of starting over.
 *
 * A streaming reader (Claude) treats one poison file as a cached skip, not as
 * a failed scan. ENOENT and timeouts are transient and are retried on a later
 * run. Non-streaming readers mark an oversized or unreadable file incomplete
 * instead of pretending the scan finished.
 */
export async function readFilesWithCache<T>(opts: {
  files: string[];
  cachePath: string;
  version: number;
  /** Parse one file's content into cacheable items. `path` lets the parser mint
   *  file-scoped identifiers (claude's synthetic request keys must never collide
   *  across files or across runs, or the max-wins dedup would merge them). */
  parseFile: (content: string, path: string) => T[];
  /** Optional bounded streaming parser for transcripts exceeding the text cap. */
  streamFile?: (path: string) => Promise<StreamRead<T>>;
  deadline: number;
  now?: () => number;
  maxFileBytes?: number;
  maxCacheBytes?: number;
}): Promise<FileCacheResult<T>> {
  const now = opts.now ?? Date.now;
  const maxFileBytes = Math.max(1, opts.maxFileBytes ?? MAX_NATIVE_FILE_BYTES);
  const maxCacheBytes = Math.max(1, opts.maxCacheBytes ?? MAX_NATIVE_CACHE_BYTES);
  const loaded = await loadCache<T>(opts.cachePath, opts.version, maxCacheBytes);
  const cached = loaded.files;
  const fresh: Record<string, CachedFile<T>> = {};
  const dropped = new Set<string>();
  const itemsByFile: T[][] = [];
  let filesRead = 0;
  const streaming = opts.streamFile !== undefined;

  const saveProgress = (files: Record<string, CachedFile<T>>) => {
    saveCache(opts.cachePath, opts.version, files, maxCacheBytes, loaded.canonical);
  };
  const abandon = (timedOut: boolean, omit?: string): FileCacheResult<T> => {
    saveProgress(progressSnapshot(cached, fresh, dropped, omit));
    return {
      itemsByFile: null,
      filesRead,
      timedOut,
      ...(timedOut ? {} : { incomplete: true }),
    };
  };

  for (const f of opts.files) {
    let size: number;
    let mtimeMs: number;
    try {
      const readStat = () => (streaming ? lstat(f) : stat(f));
      let s;
      try {
        s = await readStat();
      } catch (err) {
        if (errorCode(err) !== "ENOENT") throw err;
        s = await readStat();
      }
      if (streaming && !s.isFile()) throw new Error("Not a regular transcript");
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch (err) {
      const code = errorCode(err);
      if (code === "ENOENT") {
        dropped.add(f);
        continue;
      }
      if (streaming && (code === "EACCES" || code === "EPERM")) {
        // No size/mtime to key a skip. Leave the reader enabled and try again
        // next run rather than caching a skip we cannot invalidate.
        warnSkippedTranscript(f, "permission denied");
        continue;
      }
      if (!streaming) {
        warnIncomplete(f, code === "EACCES" || code === "EPERM" ? "permission denied" : "unreadable");
        return abandon(false, f);
      }
      return abandon(false, f);
    }
    if (!streaming && size > maxFileBytes) {
      warnIncomplete(f, "too-large");
      return abandon(false, f);
    }
    const hit = cached[f];
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
      fresh[f] = hit;
      itemsByFile.push(hit.items);
      continue;
    }
    if (now() > opts.deadline) {
      // Persist the progress made so far (keep prior entries for files not yet
      // revisited this run, so partial passes accumulate monotonic progress).
      saveProgress(progressSnapshot(cached, fresh, dropped));
      return { itemsByFile: null, filesRead, timedOut: true };
    }
    if (opts.streamFile) {
      let streamed: StreamRead<T>;
      try {
        streamed = await opts.streamFile(f);
      } catch (err) {
        streamed = failureFromThrow(err);
      }
      if (!streamed.ok && streamed.code === "ENOENT") {
        try {
          streamed = await opts.streamFile(f);
        } catch (err) {
          streamed = failureFromThrow(err);
        }
      }
      if (!streamed.ok) {
        const kind = classifyFailure(streamed);
        if (kind === "missing") {
          dropped.add(f);
          continue;
        }
        if (kind === "permanent") {
          fresh[f] = { size, mtimeMs, items: [], skipped: true };
          itemsByFile.push([]);
          warnSkippedTranscript(f, permanentLabel(streamed));
          continue;
        }
        if (kind === "timeout") {
          saveProgress(progressSnapshot(cached, fresh, dropped, f));
          return { itemsByFile: null, filesRead, timedOut: true };
        }
        return abandon(false, f);
      }
      fresh[f] = { size, mtimeMs, items: streamed.items };
      itemsByFile.push(streamed.items);
      filesRead += 1;
      continue;
    }
    let read = await readTextFileCapped(f, {
      maxBytes: maxFileBytes,
      deadline: opts.deadline,
      now,
    });
    if (!read.ok && read.code === "ENOENT") {
      read = await readTextFileCapped(f, {
        maxBytes: maxFileBytes,
        deadline: opts.deadline,
        now,
      });
    }
    if (!read.ok) {
      const kind = classifyFailure(read);
      if (kind === "missing") {
        dropped.add(f);
        continue;
      }
      if (kind === "timeout") {
        saveProgress(progressSnapshot(cached, fresh, dropped, f));
        return { itemsByFile: null, filesRead, timedOut: true };
      }
      warnIncomplete(f, kind === "permanent" ? permanentLabel(read) : "unreadable");
      return abandon(false, f);
    }
    const items = opts.parseFile(read.content, f);
    // Stat was taken BEFORE the read: if the file grew in between, the recorded
    // mtime is older than the content we parsed — the next run simply re-reads
    // it. Never the reverse (a recorded mtime newer than the parsed content).
    fresh[f] = { size, mtimeMs, items };
    itemsByFile.push(items);
    filesRead += 1;
  }

  // Completed pass: persist ONLY files that still exist (deleted transcripts
  // must drop out, or their usage would survive on disk forever).
  saveProgress(fresh);
  return { itemsByFile, filesRead, timedOut: false };
}
