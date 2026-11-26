/**
 * Collector for Amp (Sourcegraph) — both local CLI threads and cloud Orbs.
 *
 * Legacy Amp builds stored thread JSON files in `~/.local/share/amp/threads/`,
 * which `ccusage amp` reads. Modern Amp stores both local threads and cloud Orb
 * threads server-side on `ampcode.com` and exposes exact per-model token counts
 * (uncached input, cache read, cache write, output) and recorded costs through
 * `amp usage --details --start <iso> --end <iso>`.
 *
 * To respect Amp's 60 req/hr shared usage lookup limit during 15-minute
 * background syncs:
 *  - Past UTC days (fetched after the UTC day ended + a 5-minute grace window)
 *    are cached as immutable in `<configDir>/amp-usage-cache.json` and never
 *    re-fetched.
 *  - The overview (`amp usage --details --start <90d> --end <tomorrow>`) and
 *    in-progress days revalidate at most once every 15 minutes.
 *  - Each run caps network calls (`DEFAULT_AMP_MAX_REQUESTS_PER_RUN = 8`),
 *    fetching the newest uncached active days first and persisting progress
 *    even if rate-limited mid-run. Four background syncs an hour therefore
 *    spend at most 32 of the 60 lookups, leaving the rest for the user's own
 *    `amp usage`; a 90-day backfill completes within a few hours.
 *  - In `--offline` / `--local` mode, `amp` is NEVER spawned — only previously
 *    cached days on disk are returned.
 *
 * Set `WHOBURNEDMORE_AMP=0` to disable this collector.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { plausibleUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";
import { readTextFileSyncCapped, writePrivateFileAtomic } from "./safe-local-file.js";
import type { DailyUsageEntry } from "./shared.js";

const execFileAsync = promisify(execFile);

export const AMP_TOOL = "amp";
export const AMP_CACHE_VERSION = 1;
export const DEFAULT_AMP_MAX_REQUESTS_PER_RUN = 8;
export const DEFAULT_AMP_REVALIDATE_MS = 15 * 60_000;
const FINALIZE_GRACE_MS = 5 * 60_000;
const OVERVIEW_WINDOW_DAYS = 89;
const AMP_TIMEOUT_MS = 20_000;
const AMP_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
/** Cached days older than this are pruned so the cache file stays bounded. */
const CACHE_RETENTION_DAYS = 400;
const MAX_ENTRY_TOKENS = 1e15;
/**
 * Highest USD per token an uploaded row may carry. The API rejects a whole
 * upload containing any row above $200 per million tokens; Amp's ledger can
 * exceed that for image or audio models that bill per request but report few
 * tokens. Cap at $150/M so rounding can never cross the server's line.
 */
const MAX_USD_PER_TOKEN = 150 / 1_000_000;

function capCost(costUSD: number, totalTokens: number): number {
  return Number(Math.min(costUSD, totalTokens * MAX_USD_PER_TOKEN).toFixed(6));
}

export interface AmpCachedDay {
  fetchedAt: number;
  entries: DailyUsageEntry[];
}

export interface AmpUsageCache {
  v: number;
  lastIndexAt?: number;
  activeDates?: string[];
  days: Record<string, AmpCachedDay>;
}

function ampCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WHOBURNEDMORE_CONFIG_DIR?.trim();
  const dir = override || join(env.HOME || env.USERPROFILE || homedir(), ".config", "whoburnedmore");
  return join(dir, "amp-usage-cache.json");
}

function emptyCache(): AmpUsageCache {
  return { v: AMP_CACHE_VERSION, days: {} };
}

export function loadAmpCache(cachePath: string): AmpUsageCache {
  if (!existsSync(cachePath)) return emptyCache();
  try {
    const raw = readTextFileSyncCapped(cachePath, MAX_CACHE_BYTES);
    if (!raw) return emptyCache();
    const parsed = JSON.parse(raw) as Partial<AmpUsageCache>;
    if (parsed?.v !== AMP_CACHE_VERSION || !parsed.days || typeof parsed.days !== "object") {
      return emptyCache();
    }
    const days: Record<string, AmpCachedDay> = {};
    for (const [date, val] of Object.entries(parsed.days)) {
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        val &&
        typeof val.fetchedAt === "number" &&
        Number.isFinite(val.fetchedAt) &&
        Array.isArray(val.entries)
      ) {
        days[date] = { fetchedAt: val.fetchedAt, entries: sanitizeCachedEntries(val.entries, date) };
      }
    }
    return {
      v: AMP_CACHE_VERSION,
      ...(typeof parsed.lastIndexAt === "number" && Number.isFinite(parsed.lastIndexAt)
        ? { lastIndexAt: parsed.lastIndexAt }
        : {}),
      ...(Array.isArray(parsed.activeDates)
        ? { activeDates: parsed.activeDates.filter((d): d is string => typeof d === "string") }
        : {}),
      days,
    };
  } catch {
    return emptyCache();
  }
}

function tokenField(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_ENTRY_TOKENS ? v : null;
}

/**
 * Re-validate cached rows before they are submitted. The cache is our own file,
 * but a truncated write, a hand edit, or an older build's shape must never put a
 * malformed row into the payload (one bad row would fail the whole upload).
 */
function sanitizeCachedEntries(rows: unknown[], date: string): DailyUsageEntry[] {
  const out: DailyUsageEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const inputTokens = tokenField(r.inputTokens);
    const outputTokens = tokenField(r.outputTokens);
    const cacheCreationTokens = tokenField(r.cacheCreationTokens);
    const cacheReadTokens = tokenField(r.cacheReadTokens);
    const costUSD = typeof r.costUSD === "number" && Number.isFinite(r.costUSD) && r.costUSD >= 0 ? r.costUSD : null;
    if (
      r.date !== date ||
      r.tool !== AMP_TOOL ||
      typeof r.model !== "string" ||
      !r.model ||
      inputTokens === null ||
      outputTokens === null ||
      cacheCreationTokens === null ||
      cacheReadTokens === null ||
      costUSD === null ||
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0
    ) {
      continue;
    }
    out.push({
      date,
      tool: AMP_TOOL,
      model: r.model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUSD: capCost(costUSD, inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens),
      origin: "cli",
      verified: false,
    });
  }
  return out;
}

export function saveAmpCache(
  cachePath: string,
  cache: AmpUsageCache,
  now: number = Date.now(),
): boolean {
  const cutoff = utcDateString(now - CACHE_RETENTION_DAYS * 86_400_000);
  for (const date of Object.keys(cache.days)) {
    if (date < cutoff) delete cache.days[date];
  }
  if (cache.activeDates) cache.activeDates = cache.activeDates.filter((d) => d >= cutoff);
  return writePrivateFileAtomic(cachePath, JSON.stringify(cache), MAX_CACHE_BYTES);
}

/**
 * Normalize an Amp display model name (e.g. `"Opus 5.5"`, `"GPT-6.1 Sol"`,
 * `"Gemini 3.7 Flash"`) into a clean machine identifier matching `pricing.ts`
 * and `wire-sanitize.ts`.
 */
export function normalizeAmpModelName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return AMP_TOOL;

  let slug = trimmed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._:/@+~-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (!slug) return AMP_TOOL;

  // Amp displays Anthropic models without the "Claude" prefix ("Opus 5.5",
  // "Sonnet 4.6", "Haiku 4.5"). Restore it so dashboards and pricing align.
  if (/^(opus|sonnet|haiku)(?:[-._0-9]|$)/.test(slug)) {
    slug = `claude-${slug}`;
  }
  // Anthropic model ids use dashes between version digits ("claude-opus-4-6"),
  // which is how every other collector reports them. Match that so the same
  // model isn't split across two names on dashboards.
  if (slug.startsWith("claude-")) {
    slug = slug.replace(/(\d)\.(?=\d)/g, "$1-");
  }
  return slug;
}

function parseIntCell(cell: string): number {
  const cleaned = cell.replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return 0;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function parseUsdCell(cell: string): number {
  const m = cell.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function splitMarkdownRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function extractMarkdownSection(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const target = `## ${heading}`.toLowerCase();
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      if (inSection) break;
      if (trimmed.toLowerCase() === target) inSection = true;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

/**
 * Extract unique active UTC dates (`YYYY-MM-DD`, newest first) from the
 * `## Daily Recorded Cost` table of `amp usage --details`.
 */
export function parseAmpActiveDates(markdown: string, now: number = Date.now()): string[] {
  const section = extractMarkdownSection(markdown, "Daily Recorded Cost");
  const dates = new Set<string>();
  for (const line of section) {
    const cells = splitMarkdownRow(line);
    if (!cells || cells.length === 0 || isSeparatorRow(cells)) continue;
    const candidate = cells[0];
    if (plausibleUsageDate(candidate, now)) {
      dates.add(candidate);
    }
  }
  return [...dates].sort((a, b) => b.localeCompare(a));
}

/**
 * Parse the `## Models` table from a single-day `amp usage --details` report
 * into per-model `DailyUsageEntry` rows for `date`.
 */
export function parseAmpModelsTable(markdown: string, date: string): DailyUsageEntry[] {
  const section = extractMarkdownSection(markdown, "Models");
  let headerIdx: {
    model: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    cost: number;
  } | null = null;

  const byModel = new Map<string, DailyUsageEntry>();

  for (const line of section) {
    const cells = splitMarkdownRow(line);
    if (!cells || cells.length < 2) continue;
    if (!headerIdx) {
      const lower = cells.map((c) => c.toLowerCase());
      const modelCol = lower.findIndex((c) => c === "model");
      const outputCol = lower.findIndex((c) => c === "output");
      if (modelCol !== -1 && outputCol !== -1) {
        headerIdx = {
          model: modelCol,
          input: lower.findIndex((c) => c === "uncached input" || c === "input"),
          cacheRead: lower.findIndex((c) => c === "cache read"),
          cacheWrite: lower.findIndex((c) => c === "cache write"),
          output: outputCol,
          cost: lower.findIndex((c) => c === "recorded cost" || c === "cost"),
        };
      }
      continue;
    }
    if (isSeparatorRow(cells)) continue;

    const rawModel = cells[headerIdx.model] ?? "";
    if (!rawModel || /^\*\*all\b/i.test(rawModel)) continue;
    const model = normalizeAmpModelName(rawModel);

    const inputTokens = headerIdx.input >= 0 ? parseIntCell(cells[headerIdx.input] ?? "") : 0;
    const cacheReadTokens =
      headerIdx.cacheRead >= 0 ? parseIntCell(cells[headerIdx.cacheRead] ?? "") : 0;
    const cacheCreationTokens =
      headerIdx.cacheWrite >= 0 ? parseIntCell(cells[headerIdx.cacheWrite] ?? "") : 0;
    const outputTokens = headerIdx.output >= 0 ? parseIntCell(cells[headerIdx.output] ?? "") : 0;
    const recordedCost = headerIdx.cost >= 0 ? parseUsdCell(cells[headerIdx.cost] ?? "") : 0;

    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    // Linked provider connections (ChatGPT / Claude subscription) record $0.00
    // on Amp's ledger; estimate API-equivalent USD from the pricing table when
    // tokens are present, matching ccusage and tokscale repricing.
    const uncappedCost =
      recordedCost > 0
        ? recordedCost
        : totalTokens > 0
          ? estimateCostUSD(model, {
              inputTokens,
              outputTokens,
              cacheCreationTokens,
              cacheReadTokens,
            })
          : 0;

    // Token-less charges (transcription, tool fees) can't be uploaded: the
    // server rejects any row with a cost but no tokens, and rejects the WHOLE
    // submission with it. Leave them out.
    if (totalTokens === 0) continue;
    const costUSD = capCost(uncappedCost, totalTokens);

    const prev = byModel.get(model);
    if (prev) {
      prev.inputTokens += inputTokens;
      prev.outputTokens += outputTokens;
      prev.cacheCreationTokens += cacheCreationTokens;
      prev.cacheReadTokens += cacheReadTokens;
      prev.costUSD = capCost(
        prev.costUSD + costUSD,
        prev.inputTokens + prev.outputTokens + prev.cacheCreationTokens + prev.cacheReadTokens,
      );
    } else {
      byModel.set(model, {
        date,
        tool: AMP_TOOL,
        model,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUSD,
        origin: "cli",
        verified: false,
      });
    }
  }

  return [...byModel.values()];
}

/**
 * True when a day report has a `## Models` table we know how to read. A report
 * without one (an error page, a notice, or a renamed layout in a future Amp)
 * must not be cached as a finished day with no usage.
 */
export function ampModelsTableFound(markdown: string): boolean {
  for (const line of extractMarkdownSection(markdown, "Models")) {
    const cells = splitMarkdownRow(line);
    if (!cells) continue;
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.includes("model") && lower.includes("output")) return true;
  }
  return false;
}

/** True when a cached UTC day was fetched after that UTC day finished + grace window. */
export function isAmpDayFinal(date: string, fetchedAt: number): boolean {
  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) return false;
  return fetchedAt >= startMs + 86_400_000 + FINALIZE_GRACE_MS;
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcDateString(date: string): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return utcDateString(ms + 86_400_000);
}

/** Locate a trustworthy `amp` binary from known install locations (never PATH). */
export function resolveAmpBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const os = platform();
  const explicit = env.AMP_BIN?.trim();
  const candidates = explicit
    ? [explicit]
    : os === "win32"
      ? [
          join(home, ".amp", "bin", "amp.exe"),
          ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "amp", "amp.exe")] : []),
        ]
      : [
          join(home, ".amp", "bin", "amp"),
          join(home, ".local", "bin", "amp"),
          "/opt/homebrew/bin/amp",
          "/usr/local/bin/amp",
          "/usr/bin/amp",
        ];

  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      const stat = statSync(resolved);
      if (!stat.isFile()) continue;
      if (os !== "win32" && (stat.mode & 0o022) !== 0) continue;
      return resolved;
    } catch {
      /* not installed or not a trustworthy regular file */
    }
  }
  return null;
}

/** Quick local check so machines where Amp was never signed in skip spawning `amp`. */
export function hasAmpCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AMP_API_KEY?.trim()) return true;
  const home = env.HOME || env.USERPROFILE || homedir();
  const dataRoot =
    platform() === "win32"
      ? env.APPDATA ?? join(home, "AppData", "Roaming")
      : env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return existsSync(join(dataRoot, "amp", "secrets.json"));
}

export type AmpRunner = (args: string[]) => Promise<string>;

function defaultAmpRunner(bin: string, env: NodeJS.ProcessEnv): AmpRunner {
  return async (args: string[]) => {
    const { stdout } = await execFileAsync(bin, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: AMP_TIMEOUT_MS,
      maxBuffer: AMP_MAX_BUFFER_BYTES,
      // AMP_SKIP_UPDATE_CHECK: a background usage lookup must never make Amp
      // check for or install an update of itself.
      env: { ...env, NO_COLOR: "1", NO_ANIMATION: "1", AMP_SKIP_UPDATE_CHECK: "1" },
    });
    return stdout;
  };
}

export interface CollectAmpOpts {
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: number;
  cachePath?: string;
  maxRequestsPerRun?: number;
  revalidateMs?: number;
  ampBin?: string | null;
  runner?: AmpRunner;
}

function flattenCacheEntries(cache: AmpUsageCache, now: number): DailyUsageEntry[] {
  const out: DailyUsageEntry[] = [];
  for (const [date, day] of Object.entries(cache.days)) {
    if (!plausibleUsageDate(date, now)) continue;
    for (const entry of day.entries) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Best-effort Amp collector covering both local CLI threads and cloud Orbs.
 * Falls back cleanly to cached entries on offline runs or transient errors.
 */
export async function collectAmp(
  opts: CollectAmpOpts = {},
): Promise<{ entries: DailyUsageEntry[]; found: boolean }> {
  const env = opts.env ?? process.env;
  if (env.WHOBURNEDMORE_AMP === "0") {
    return { entries: [], found: false };
  }
  const now = opts.now ?? Date.now();
  const cachePath = opts.cachePath ?? ampCachePath(env);
  const cache = loadAmpCache(cachePath);

  if (opts.offline) {
    const cached = flattenCacheEntries(cache, now);
    return { entries: cached, found: cached.length > 0 };
  }

  let runner = opts.runner;
  if (!runner) {
    if (!hasAmpCredentials(env)) {
      const cached = flattenCacheEntries(cache, now);
      return { entries: cached, found: cached.length > 0 };
    }
    const bin = opts.ampBin === undefined ? resolveAmpBin(env) : opts.ampBin;
    if (!bin) {
      const cached = flattenCacheEntries(cache, now);
      return { entries: cached, found: cached.length > 0 };
    }
    runner = defaultAmpRunner(bin, env);
  }

  const revalidateMs = opts.revalidateMs ?? DEFAULT_AMP_REVALIDATE_MS;
  let budget = Math.max(0, opts.maxRequestsPerRun ?? DEFAULT_AMP_MAX_REQUESTS_PER_RUN);
  let dirty = false;

  const activeSet = new Set<string>(
    (cache.activeDates ?? []).filter((d) => plausibleUsageDate(d, now)),
  );

  // Refresh the active-date index at most once per revalidate window.
  const needsIndex = !cache.lastIndexAt || now - cache.lastIndexAt >= revalidateMs;
  if (needsIndex && budget > 0) {
    budget -= 1;
    try {
      const startDate = utcDateString(now - OVERVIEW_WINDOW_DAYS * 86_400_000);
      const endDate = utcDateString(now + 86_400_000);
      const overview = await runner([
        "usage",
        "--details",
        "--start",
        `${startDate}T00:00:00.000Z`,
        "--end",
        `${endDate}T00:00:00.000Z`,
      ]);
      const discovered = parseAmpActiveDates(overview, now);
      for (const d of discovered) activeSet.add(d);
      cache.lastIndexAt = now;
      cache.activeDates = [...activeSet].sort((a, b) => b.localeCompare(a));
      dirty = true;
    } catch {
      // Rate-limited, logged out, or offline — fall through to any cached days.
      const cached = flattenCacheEntries(cache, now);
      return { entries: cached, found: cached.length > 0 };
    }
  }

  const sortedDates = [...activeSet].sort((a, b) => b.localeCompare(a));
  for (const date of sortedDates) {
    if (budget <= 0) break;
    const existing = cache.days[date];
    if (existing) {
      if (isAmpDayFinal(date, existing.fetchedAt)) continue;
      if (now - existing.fetchedAt < revalidateMs) continue;
    }
    budget -= 1;
    try {
      const nextDate = nextUtcDateString(date);
      const report = await runner([
        "usage",
        "--details",
        "--start",
        `${date}T00:00:00.000Z`,
        "--end",
        `${nextDate}T00:00:00.000Z`,
      ]);
      // Unreadable report: stop here and retry on a later run instead of
      // caching the day as final and empty.
      if (!ampModelsTableFound(report)) break;
      const entries = parseAmpModelsTable(report, date);
      cache.days[date] = { fetchedAt: now, entries };
      dirty = true;
    } catch {
      // Stop on the first failure (e.g. 429 rate limit) and keep what we cached.
      break;
    }
  }

  if (dirty) {
    saveAmpCache(cachePath, cache, now);
  }

  const entries = flattenCacheEntries(cache, now);
  return { entries, found: entries.length > 0 };
}
