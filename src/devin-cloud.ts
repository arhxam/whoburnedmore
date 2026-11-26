/**
 * Collector for Devin Cloud ("devin-cloud") sessions.
 *
 * Devin Cloud runs on Cognition's hosted VMs and meters usage in ACUs (Agent
 * Compute Units) — or granular tokens on DOLLARS-billed teams via Analytics v2.
 * Unlike local Devin CLI sessions (`src/native/devin.ts`), hosted cloud
 * sessions do not write LLM token metrics to disk.
 *
 * Three best-effort sources, checked in priority order so no day is double
 * counted:
 *
 *  1. Opt-in Devin/Windsurf Analytics v2alpha API (`DEVIN_ANALYTICS_SERVICE_KEY`,
 *     skipped in `--offline` mode). Returns exact per-day × model token counts
 *     for DOLLARS-billed teams, or `billed_acus` on ACU plans.
 *  2. Opt-in Devin Enterprise v3 daily consumption API (`DEVIN_API_KEY` +
 *     `DEVIN_SERVICE_USER_ID` or `DEVIN_ORG_ID` / `~/.config/devin/config.json`,
 *     skipped in `--offline` mode). Returns daily ACU consumption (`acus`).
 *  3. Local Devin Desktop Cloud session cache (`User/acp-messages/*.db`),
 *     purely offline. Devin Desktop caches each Cloud session in its own SQLite
 *     DB with `cognition.ai/acuAmount` cumulative high-water marks (local CLI
 *     sessions cached in the same directory have no `source_history` / `org_id`
 *     and are skipped so they never double-count with `devin`).
 *
 * ACU-only records are converted to `costUSD` at `WHOBURNEDMORE_DEVIN_ACU_USD`
 * (default $2.00/ACU) with zero token counts — tokens are NEVER fabricated from
 * ACUs. Set `WHOBURNEDMORE_DEVIN_CLOUD=0` to disable this collector entirely.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readJsonResponseCapped } from "./http-bounds.js";
import { isDevinRoutingMode } from "./native/devin.js";
import { localUsageDate, plausibleUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";
import type { DailyUsageEntry } from "./shared.js";

export const DEVIN_CLOUD_TOOL = "devin-cloud";

/** Default list USD value per Devin ACU when no override is configured. */
export const DEFAULT_DEVIN_ACU_USD = 2.0;

const DEFAULT_ANALYTICS_API_URL = "https://server.codeium.com";
const DEFAULT_DEVIN_API_URL = "https://api.devin.ai";
const MAX_API_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_ANALYTICS_PAGES = 20;
const ANALYTICS_WINDOW_DAYS = 89;
const API_TIMEOUT_MS = 20_000;

function nonNegInt(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function nonNegNum(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Parse `WHOBURNEDMORE_DEVIN_ACU_USD`, falling back to `DEFAULT_DEVIN_ACU_USD`. */
export function resolveDevinAcuUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WHOBURNEDMORE_DEVIN_ACU_USD?.trim();
  if (!raw) return DEFAULT_DEVIN_ACU_USD;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0 && v <= 1000) return v;
  return DEFAULT_DEVIN_ACU_USD;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n >= 1e12 ? Math.round(n) : Math.round(n * 1000);
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value >= 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  return null;
}

function trustedSqliteBinaries(): string[] {
  const os = platform();
  const candidates =
    os === "darwin"
      ? ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]
      : os === "linux"
        ? ["/usr/bin/sqlite3", "/usr/local/bin/sqlite3"]
        : [];
  const trusted: string[] = [];
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      const stat = statSync(resolved);
      if (stat.isFile() && (stat.mode & 0o022) === 0) trusted.push(resolved);
    } catch {
      /* not installed or not a trustworthy regular file */
    }
  }
  return [...new Set(trusted)];
}

/** Candidate directories containing Devin Desktop's `acp-messages/*.db` caches. */
export function devinAcpMessagesDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  const override = env.DEVIN_DESKTOP_DATA_DIR?.trim();
  if (override) {
    dirs.push(join(override, "acp-messages"));
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  const os = platform();
  if (os === "darwin") {
    dirs.push(join(home, "Library", "Application Support", "Devin", "User", "acp-messages"));
  } else if (os === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    dirs.push(join(appData, "Devin", "User", "acp-messages"));
  } else {
    const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    dirs.push(join(xdg, "Devin", "User", "acp-messages"));
    dirs.push(join(xdg, "devin", "User", "acp-messages"));
  }
  return [...new Set(dirs)];
}

/** Read meta + ACU-carrying message rows from one ACP SQLite database. */
function readAcpDb(dbPath: string): {
  meta: Record<string, string>;
  payloads: string[];
} | null {
  const require = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const metaRows = db.prepare("SELECT key, value FROM meta").all() as Array<{
        key?: unknown;
        value?: unknown;
      }>;
      const meta: Record<string, string> = {};
      for (const r of metaRows) {
        if (typeof r.key === "string" && typeof r.value === "string") {
          meta[r.key] = r.value;
        }
      }
      if (!isDevinCloudMeta(meta)) return { meta, payloads: [] };
      const msgRows = db
        .prepare(
          "SELECT payload FROM messages WHERE payload LIKE '%acuAmount%' OR payload LIKE '%acuConsumption%' ORDER BY position",
        )
        .all() as Array<{ payload?: unknown }>;
      const payloads = msgRows
        .map((r) => (typeof r.payload === "string" ? r.payload : ""))
        .filter(Boolean);
      return { meta, payloads };
    } finally {
      db.close();
    }
  } catch {
    /* node:sqlite unavailable or locked — fall back to a trusted sqlite3 binary */
  }

  for (const sqlite3 of trustedSqliteBinaries()) {
    try {
      const metaRes = spawnSync(sqlite3, ["-json", dbPath, "SELECT key, value FROM meta;"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (metaRes.status !== 0) continue;
      const parsedMeta = metaRes.stdout.trim()
        ? (JSON.parse(metaRes.stdout) as Array<{ key?: unknown; value?: unknown }>)
        : [];
      const meta: Record<string, string> = {};
      for (const r of parsedMeta) {
        if (typeof r.key === "string" && typeof r.value === "string") {
          meta[r.key] = r.value;
        }
      }
      if (!isDevinCloudMeta(meta)) return { meta, payloads: [] };
      const msgRes = spawnSync(
        sqlite3,
        [
          "-json",
          dbPath,
          "SELECT payload FROM messages WHERE payload LIKE '%acuAmount%' OR payload LIKE '%acuConsumption%' ORDER BY position;",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      if (msgRes.status !== 0) continue;
      const parsedMsgs = msgRes.stdout.trim()
        ? (JSON.parse(msgRes.stdout) as Array<{ payload?: unknown }>)
        : [];
      const payloads = parsedMsgs
        .map((r) => (typeof r.payload === "string" ? r.payload : ""))
        .filter(Boolean);
      return { meta, payloads };
    } catch {
      /* try next trusted sqlite3 binary */
    }
  }
  return null;
}

/**
 * True when an `acp-messages` DB represents a hosted Devin Cloud session
 * rather than a local Devin CLI session cached in Desktop.
 */
export function isDevinCloudMeta(meta: Record<string, string>): boolean {
  if (typeof meta.source_history === "string" && meta.source_history.trim().length > 0) {
    return true;
  }
  if (typeof meta.info === "string" && meta.info.includes('"org_id"')) {
    return true;
  }
  return false;
}

/** Extract the cloud session id (e.g. `devin-…`) from `meta.source_history` cursors. */
export function extractDevinCloudSessionId(meta: Record<string, string>): string | null {
  if (!meta.source_history) return null;
  try {
    const sh = JSON.parse(meta.source_history) as {
      replayedTail?: { start?: { cursor?: string }; end?: { cursor?: string } };
    };
    const cursor = sh.replayedTail?.end?.cursor ?? sh.replayedTail?.start?.cursor;
    if (typeof cursor !== "string" || !cursor) return null;
    const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as {
      session?: unknown;
    };
    if (typeof decoded.session === "string" && decoded.session.trim()) {
      return decoded.session.trim();
    }
  } catch {
    /* ignore malformed cursor */
  }
  return null;
}

/** Extract the cloud model / Devin version from `meta.info.configOptions`. */
export function extractDevinCloudModel(meta: Record<string, string>): string {
  if (!meta.info) return DEVIN_CLOUD_TOOL;
  try {
    const info = JSON.parse(meta.info) as {
      configOptions?: Array<{ id?: unknown; currentValue?: unknown }>;
    };
    if (!Array.isArray(info.configOptions)) return DEVIN_CLOUD_TOOL;
    const opt =
      info.configOptions.find((o) => o?.id === "model" && typeof o.currentValue === "string" && o.currentValue.trim()) ??
      info.configOptions.find(
        (o) => o?.id === "devin_version" && typeof o.currentValue === "string" && o.currentValue.trim(),
      );
    const val = typeof opt?.currentValue === "string" ? opt.currentValue.trim() : "";
    if (val && !isDevinRoutingMode(val)) return val;
  } catch {
    /* ignore malformed info */
  }
  return DEVIN_CLOUD_TOOL;
}

export interface ParsedDevinCloudSession {
  sessionKey: string;
  model: string;
  /** Daily ACU deltas for this session: `YYYY-MM-DD` -> ACUs consumed that day. */
  acusByDate: Map<string, number>;
  totalAcus: number;
}

/**
 * Parse one Devin Cloud ACP session's message payloads into per-day ACU deltas.
 *
 * `cognition.ai/acuAmount` (on `acu_consumption_at_last_user_interaction`) is a
 * cumulative session total and can appear out-of-order after history replay.
 * Sorting samples by timestamp and accumulating monotonic increases attributes
 * each increment to the local day it occurred without double-counting repeated
 * snapshots. Falls back to positive `cognition.ai/acuConsumption` event deltas
 * only when no cumulative `acuAmount` > 0 is present.
 */
export function parseDevinCloudPayloads(
  meta: Record<string, string>,
  payloads: readonly string[],
  fallbackKey: string,
  now: number = Date.now(),
): ParsedDevinCloudSession | null {
  if (!isDevinCloudMeta(meta)) return null;
  const sessionKey = extractDevinCloudSessionId(meta) ?? fallbackKey;
  const model = extractDevinCloudModel(meta);

  const cumulativeSamples: Array<{ ms: number; acu: number }> = [];
  const incrementalSamples: Array<{ ms: number; acu: number }> = [];

  for (const raw of payloads) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const content = p.content as Record<string, unknown> | undefined;
    const cmeta = (content?._meta ?? p._meta) as Record<string, unknown> | undefined;
    if (!cmeta || typeof cmeta !== "object") continue;

    const ms =
      toEpochMs(cmeta["cognition.ai/timestamp"]) ??
      toEpochMs(cmeta["cognition.ai/createdAtMs"]) ??
      toEpochMs(p.sourceEventTimestampMs);
    if (ms === null) continue;

    const acuAmount = cmeta["cognition.ai/acuAmount"];
    if (typeof acuAmount === "number" && Number.isFinite(acuAmount) && acuAmount >= 0) {
      cumulativeSamples.push({ ms, acu: acuAmount });
    }
    const acuDelta = cmeta["cognition.ai/acuConsumption"];
    if (typeof acuDelta === "number" && Number.isFinite(acuDelta) && acuDelta > 0) {
      incrementalSamples.push({ ms, acu: acuDelta });
    }
  }

  const acusByDate = new Map<string, number>();
  let totalAcus = 0;

  const maxCumulative = cumulativeSamples.reduce((m, s) => (s.acu > m ? s.acu : m), 0);
  if (maxCumulative > 0) {
    cumulativeSamples.sort((a, b) => a.ms - b.ms || a.acu - b.acu);
    let highWater = 0;
    for (const sample of cumulativeSamples) {
      if (sample.acu <= highWater) continue;
      const delta = sample.acu - highWater;
      highWater = sample.acu;
      const date = localUsageDate(sample.ms, now);
      if (!date) continue;
      acusByDate.set(date, (acusByDate.get(date) ?? 0) + delta);
      totalAcus += delta;
    }
  } else if (incrementalSamples.length > 0) {
    for (const sample of incrementalSamples) {
      const date = localUsageDate(sample.ms, now);
      if (!date) continue;
      acusByDate.set(date, (acusByDate.get(date) ?? 0) + sample.acu);
      totalAcus += sample.acu;
    }
  }

  return { sessionKey, model, acusByDate, totalAcus };
}

/** Fold parsed Devin Cloud sessions into per-(date, model) DailyUsageEntry rows. */
export function aggregateDevinCloudSessions(
  sessions: readonly ParsedDevinCloudSession[],
  acuUsd: number = DEFAULT_DEVIN_ACU_USD,
): DailyUsageEntry[] {
  // Deduplicate by sessionKey, keeping the cache snapshot with the highest ACU total.
  const bestBySession = new Map<string, ParsedDevinCloudSession>();
  for (const s of sessions) {
    const prev = bestBySession.get(s.sessionKey);
    if (!prev || s.totalAcus > prev.totalAcus) {
      bestBySession.set(s.sessionKey, s);
    }
  }

  const byKey = new Map<string, { date: string; model: string; acus: number }>();
  for (const s of bestBySession.values()) {
    for (const [date, acus] of s.acusByDate.entries()) {
      if (acus <= 0) continue;
      const key = `${date}|${s.model}`;
      const acc = byKey.get(key) ?? { date, model: s.model, acus: 0 };
      acc.acus += acus;
      byKey.set(key, acc);
    }
  }

  const entries: DailyUsageEntry[] = [];
  for (const row of byKey.values()) {
    const costUSD = Number((row.acus * acuUsd).toFixed(6));
    if (costUSD <= 0) continue;
    entries.push({
      date: row.date,
      tool: DEVIN_CLOUD_TOOL,
      model: row.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD,
      origin: "cli",
      verified: false,
    });
  }
  return entries;
}

/** Collect Devin Cloud usage strictly from local Devin Desktop `acp-messages/*.db` caches. */
export function collectDevinCloudLocal(opts: {
  acpMessagesDirs?: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
} = {}): { entries: DailyUsageEntry[]; found: boolean } {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const acuUsd = resolveDevinAcuUsd(env);
  const dirs = opts.acpMessagesDirs ?? devinAcpMessagesDirs(env);

  let foundCloudDb = false;
  const sessions: ParsedDevinCloudSession[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const dbPath = join(dir, name);
      const data = readAcpDb(dbPath);
      if (!data || !isDevinCloudMeta(data.meta)) continue;
      foundCloudDb = true;
      const parsed = parseDevinCloudPayloads(data.meta, data.payloads, dbPath, now);
      if (parsed && parsed.totalAcus > 0) {
        sessions.push(parsed);
      }
    }
  }

  return {
    entries: aggregateDevinCloudSessions(sessions, acuUsd),
    found: foundCloudDb,
  };
}

// ---------------------------------------------------------------------------
// Opt-in Devin Cloud API collectors (never invoked unless explicitly configured
// via env vars, and never invoked in `--offline` mode).
// ---------------------------------------------------------------------------

export interface DevinAnalyticsRow {
  timestamp?: string;
  model_uid?: string;
  tokens?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  consumption?: {
    billed_acus?: number;
    message_count?: number;
  };
}

/** Pure mapper for `GET /api/v2alpha/analytics/consumption` rows. */
export function mapDevinAnalyticsRows(
  rows: readonly DevinAnalyticsRow[],
  acuUsd: number = DEFAULT_DEVIN_ACU_USD,
  now: number = Date.now(),
): DailyUsageEntry[] {
  const byKey = new Map<string, DailyUsageEntry>();

  for (const row of rows) {
    if (!row || typeof row.timestamp !== "string" || !plausibleUsageDate(row.timestamp, now)) {
      continue;
    }
    const rawModel = typeof row.model_uid === "string" ? row.model_uid.trim() : "";
    const model = rawModel && !isDevinRoutingMode(rawModel) ? rawModel : DEVIN_CLOUD_TOOL;

    const inputTokens = nonNegInt(row.tokens?.input_tokens);
    const outputTokens = nonNegInt(row.tokens?.output_tokens);
    const cacheCreationTokens = nonNegInt(row.tokens?.cache_write_tokens);
    const cacheReadTokens = nonNegInt(row.tokens?.cache_read_tokens);
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

    let costUSD = 0;
    if (totalTokens > 0) {
      costUSD = estimateCostUSD(model, {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
      });
    } else {
      const acus = nonNegNum(row.consumption?.billed_acus);
      if (acus <= 0) continue;
      costUSD = acus * acuUsd;
    }

    const key = `${row.timestamp}|${model}`;
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
      date: row.timestamp,
      tool: DEVIN_CLOUD_TOOL,
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

  return [...byKey.values()];
}

export interface DevinV3DailyItem {
  date?: number | string;
  acus?: number;
  acus_by_product?: {
    devin?: number | null;
    automation?: number | null;
    cascade?: number | null;
    terminal?: number | null;
    review?: number | null;
  };
}

/** Pure mapper for `GET /v3/.../consumption/daily` responses. */
export function mapDevinV3Consumption(
  items: readonly DevinV3DailyItem[],
  acuUsd: number = DEFAULT_DEVIN_ACU_USD,
  now: number = Date.now(),
): DailyUsageEntry[] {
  const byDate = new Map<string, number>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    let date: string | null = null;
    if (typeof item.date === "string" && plausibleUsageDate(item.date, now)) {
      date = item.date;
    } else {
      const ms = toEpochMs(item.date);
      if (ms !== null) date = localUsageDate(ms, now);
    }
    if (!date) continue;

    // Prefer Devin-specific product ACUs when `acus_by_product` is populated so
    // Cascade/Terminal aren't conflated with Devin Cloud; fall back to total
    // `acus` only when no product breakdown is provided.
    let acus = 0;
    const byProduct = item.acus_by_product;
    if (byProduct && typeof byProduct === "object" && Object.keys(byProduct).length > 0) {
      acus =
        nonNegNum(byProduct.devin) +
        nonNegNum(byProduct.automation) +
        nonNegNum(byProduct.review);
    } else {
      acus = nonNegNum(item.acus);
    }
    if (acus <= 0) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + acus);
  }

  const entries: DailyUsageEntry[] = [];
  for (const [date, acus] of byDate.entries()) {
    const costUSD = Number((acus * acuUsd).toFixed(6));
    if (costUSD <= 0) continue;
    entries.push({
      date,
      tool: DEVIN_CLOUD_TOOL,
      model: DEVIN_CLOUD_TOOL,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD,
      origin: "cli",
      verified: false,
    });
  }
  return entries;
}

/** Read `devin.org_id` from `~/.config/devin/config.json` (or `XDG_CONFIG_HOME`). */
export function readDevinOrgId(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.DEVIN_ORG_ID?.trim();
  if (explicit) return explicit;
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "devin", "config.json"),
  ];
  if (platform() === "win32" && env.APPDATA) {
    candidates.unshift(join(env.APPDATA, "devin", "config.json"));
  }
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { devin?: { org_id?: unknown } };
      if (typeof raw?.devin?.org_id === "string" && raw.devin.org_id.trim()) {
        return raw.devin.org_id.trim();
      }
    } catch {
      /* missing or unreadable */
    }
  }
  return null;
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Fetch daily consumption from Analytics v2alpha (opt-in via `DEVIN_ANALYTICS_SERVICE_KEY`). */
export async function fetchDevinAnalytics(
  serviceKey: string,
  opts: {
    baseUrl?: string;
    userId?: string;
    now?: number;
    maxPages?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DevinAnalyticsRow[]> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_ANALYTICS_API_URL).replace(/\/+$/, "");
  const now = opts.now ?? Date.now();
  const endDate = formatUtcDate(now);
  const startDate = formatUtcDate(now - ANALYTICS_WINDOW_DAYS * 86_400_000);
  const maxPages = opts.maxPages ?? MAX_ANALYTICS_PAGES;

  const all: DevinAnalyticsRow[] = [];
  let cursor: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${baseUrl}/api/v2alpha/analytics/consumption`);
    url.searchParams.set("product", "agent");
    url.searchParams.set("granularity", "daily");
    url.searchParams.set("group_by", "model_uid");
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    if (opts.userId) url.searchParams.set("user_id", opts.userId);
    if (cursor) url.searchParams.set("page_cursor", cursor);

    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) {
      throw new Error(`devin analytics page ${page} failed (HTTP ${res.status})`);
    }
    const body = await readJsonResponseCapped<{
      data?: DevinAnalyticsRow[];
      pagination?: { next_page_cursor?: string | null };
    }>(res, MAX_API_PAGE_BYTES);
    if (Array.isArray(body.data)) all.push(...body.data);
    cursor = body.pagination?.next_page_cursor ?? null;
    if (!cursor) break;
  }
  if (cursor) {
    throw new Error(`devin analytics exceeded page cap (${maxPages})`);
  }
  return all;
}

/** Fetch daily ACU consumption from Devin Enterprise v3 API (opt-in via `DEVIN_API_KEY`). */
export async function fetchDevinV3Consumption(
  apiKey: string,
  opts: {
    baseUrl?: string;
    orgId?: string;
    serviceUserId?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DevinV3DailyItem[]> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_DEVIN_API_URL).replace(/\/+$/, "");
  const path = opts.serviceUserId
    ? `/v3/enterprise/consumption/daily/service-users/${encodeURIComponent(opts.serviceUserId)}`
    : opts.orgId
      ? `/v3/organizations/${encodeURIComponent(opts.orgId)}/consumption/daily`
      : null;
  if (!path) return [];

  const res = await fetchFn(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: "error",
  });
  if (!res.ok) {
    throw new Error(`devin v3 consumption failed (HTTP ${res.status})`);
  }
  const body = await readJsonResponseCapped<{
    consumption_by_date?: DevinV3DailyItem[];
  }>(res, MAX_API_PAGE_BYTES);
  return Array.isArray(body.consumption_by_date) ? body.consumption_by_date : [];
}

export interface CollectDevinCloudOpts {
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  acpMessagesDirs?: string[];
  now?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Best-effort Devin Cloud collection:
 *  1. Opt-in Analytics v2alpha API (`DEVIN_ANALYTICS_SERVICE_KEY`), when online
 *  2. Opt-in Enterprise v3 consumption API (`DEVIN_API_KEY`), when online
 *  3. Local Devin Desktop `acp-messages/*.db` cloud session caches (offline-safe)
 */
export async function collectDevinCloud(
  opts: CollectDevinCloudOpts = {},
): Promise<{ entries: DailyUsageEntry[]; found: boolean }> {
  const env = opts.env ?? process.env;
  if (env.WHOBURNEDMORE_DEVIN_CLOUD === "0") {
    return { entries: [], found: false };
  }
  const now = opts.now ?? Date.now();
  const acuUsd = resolveDevinAcuUsd(env);

  if (!opts.offline) {
    const analyticsKey = env.DEVIN_ANALYTICS_SERVICE_KEY?.trim();
    if (analyticsKey) {
      try {
        const rows = await fetchDevinAnalytics(analyticsKey, {
          baseUrl: env.DEVIN_ANALYTICS_API_URL?.trim() || undefined,
          userId: env.DEVIN_USER_ID?.trim() || undefined,
          now,
          fetchImpl: opts.fetchImpl,
        });
        const entries = mapDevinAnalyticsRows(rows, acuUsd, now);
        if (entries.length > 0) return { entries, found: true };
      } catch {
        /* fall through to v3 API or local cache */
      }
    }

    const devinApiKey = env.DEVIN_API_KEY?.trim();
    if (devinApiKey) {
      const serviceUserId = env.DEVIN_SERVICE_USER_ID?.trim() || undefined;
      const orgId = serviceUserId ? undefined : readDevinOrgId(env) ?? undefined;
      if (serviceUserId || orgId) {
        try {
          const items = await fetchDevinV3Consumption(devinApiKey, {
            baseUrl: env.DEVIN_API_URL?.trim() || undefined,
            orgId,
            serviceUserId,
            fetchImpl: opts.fetchImpl,
          });
          const entries = mapDevinV3Consumption(items, acuUsd, now);
          if (entries.length > 0) return { entries, found: true };
        } catch {
          /* fall through to local cache */
        }
      }
    }
  }

  try {
    return collectDevinCloudLocal({
      acpMessagesDirs: opts.acpMessagesDirs,
      env,
      now,
    });
  } catch {
    return { entries: [], found: false };
  }
}
