/**
 * Upgrade awareness for the CLI — read-only and best-effort.
 *
 * The background sync agent is pinned to the exact CLI version that installed it
 * (see autosync.ts — a deliberate choice: never execute the mutable `latest`
 * dist-tag on a timer). The pin only advances when the user runs a newer CLI in
 * the foreground. Nothing told the user a newer CLI existed, so a machine could
 * sync happily for months while newly supported agents (whose readers only exist
 * in later releases) never appeared on their board.
 *
 * This module closes that gap without touching the security posture: once a day
 * it fetches the npm registry's tiny `latest` document — a read-only GET, no
 * user data, the same class of call as the LiteLLM pricing refresh — and caches
 * the answer. Foreground runs print an upgrade nudge; background ticks refresh
 * the cache silently so `status` and the next foreground run know. The fetch
 * never blocks a run (it is raced against collection), never fails a run, and
 * is skipped entirely in `--local` mode so the "fully offline" promise holds.
 */
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { defaultConfigDir } from "./config.js";
import { readJsonResponseCapped } from "./http-bounds.js";
import { readTextFileCapped } from "./native/file-cache.js";
import { readTextFileSyncCapped } from "./safe-local-file.js";

/** Registry document holding only the dist-tag's version — a few hundred bytes. */
const DEFAULT_LATEST_URL = "https://registry.npmjs.org/whoburnedmore/latest";
/** Once a day is plenty: releases are rare, and every tick reading the cache is free. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap on the fetch — the check is raced against collection, but a stuck
 *  registry must never hold a run (or a background tick) hostage. */
const FETCH_TIMEOUT_MS = 5_000;
/** The document is tiny; anything larger is not what we asked for. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface LatestVersionCache {
  fetchedAt: number;
  version: string;
}

export function latestVersionCachePath(dir = defaultConfigDir()): string {
  return join(dir, "latest-version-cache.json");
}

/** Parse a strict `x.y.z` version into numeric triplets, or null when the shape
 *  is anything else (prereleases, tags, garbage). Build metadata is ignored. */
export function parseVersion(version: unknown): [number, number, number] | null {
  if (typeof version !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `latest` is strictly newer than `current`. Unparseable input is
 *  never "newer" — a corrupt registry answer must not cry wolf. */
export function isNewerVersion(current: string, latest: unknown): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}

/** Read the cached `latest` answer without any network. Missing/corrupt cache
 *  reads as absent — callers treat that as "no information", never an error. */
export async function readLatestVersionCache(
  path: string = latestVersionCachePath(),
): Promise<LatestVersionCache | null> {
  try {
    const read = await readTextFileCapped(path, { maxBytes: MAX_RESPONSE_BYTES });
    if (!read.ok) return null;
    const parsed = JSON.parse(read.content) as LatestVersionCache;
    if (
      typeof parsed?.fetchedAt === "number" &&
      Number.isFinite(parsed.fetchedAt) &&
      parseVersion(parsed.version)
    ) {
      return parsed;
    }
  } catch {
    // missing or corrupt cache — treat as absent
  }
  return null;
}

/** Synchronous cache read for callers that cannot await (the `status` report is
 *  built synchronously). The file is a few dozen bytes, so a sync read is fine. */
export function readLatestVersionCacheSync(
  path: string = latestVersionCachePath(),
): LatestVersionCache | null {
  try {
    const content = readTextFileSyncCapped(path, MAX_RESPONSE_BYTES);
    if (content === null) return null;
    const parsed = JSON.parse(content) as LatestVersionCache;
    if (
      typeof parsed?.fetchedAt === "number" &&
      Number.isFinite(parsed.fetchedAt) &&
      parseVersion(parsed.version)
    ) {
      return parsed;
    }
  } catch {
    // missing or corrupt cache — treat as absent
  }
  return null;
}

async function fetchLatestVersion(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
      // A plain GET — no cookies, no auth, nothing about this machine or its
      // usage crosses the wire beyond what npm already sees when it installs.
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = await readJsonResponseCapped<{ version?: unknown }>(res, MAX_RESPONSE_BYTES);
    return parseVersion(body?.version) ? (body.version as string).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Refresh the cached `latest` version once per TTL. Returns the freshest known
 * version (live or cache), or null when nothing is known. Never throws, never
 * blocks long, and performs no network at all when the cache is fresh, when
 * WHOBURNEDMORE_VERSION_CHECK_OFFLINE is set, or when `offline` is passed
 * (`--local` runs must stay literally offline).
 */
export async function refreshLatestVersion(
  opts: {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    cachePath?: string;
    offline?: boolean;
  } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  if (opts.offline || env.WHOBURNEDMORE_VERSION_CHECK_OFFLINE) return null;

  const path = opts.cachePath ?? latestVersionCachePath();
  const cached = await readLatestVersionCache(path);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return cached.version;

  const live = await fetchLatestVersion(env.WHOBURNEDMORE_VERSION_CHECK_URL ?? DEFAULT_LATEST_URL);
  if (!live) return cached?.version ?? null;

  try {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    // Write-then-rename so a concurrent run (foreground + background sync) can
    // never read a torn half-written cache.
    const serialized = JSON.stringify({ fetchedAt: now(), version: live });
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  } catch {
    // cache write is best-effort; the live answer is already in hand
  }
  return live;
}

/**
 * The foreground upgrade nudge. Explains the one thing users cannot guess: the
 * background sync does not follow `latest`, so new-agent support only arrives
 * when they re-run the CLI once themselves. Pure for tests.
 */
export function updateNoticeLines(currentVersion: string, latestVersion: string): string[] {
  // Both strings are only ever printed after isNewerVersion() accepts them, which
  // means they matched parseVersion's strict charset — no control bytes can reach
  // the terminal. Guard anyway so a future caller can't print raw network text.
  if (!parseVersion(currentVersion) || !parseVersion(latestVersion)) return [];
  return [
    `  ⚠ whoburnedmore v${latestVersion} is out — you're on v${currentVersion}.`,
    "    New versions read more agents, but background sync stays pinned to the version that installed it.",
    `    Run \`npx whoburnedmore@latest\` once to upgrade it.`,
  ];
}
