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
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readJsonResponseCapped } from "./http-bounds.js";
import { isDevinRoutingMode } from "./native/devin.js";
import { localUsageDate, plausibleUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";
import { readTextFileSyncCapped, writePrivateFileAtomic } from "./safe-local-file.js";
import type { DailyUsageEntry } from "./shared.js";

export const DEVIN_CLOUD_TOOL = "devin-cloud";

/** Default list USD value per Devin ACU when no override is configured. */
export const DEFAULT_DEVIN_ACU_USD = 2.0;

const DEFAULT_ANALYTICS_API_URL = "https://server.codeium.com";
const DEFAULT_DEVIN_API_URL = "https://api.devin.ai";
const MAX_API_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_ANALYTICS_PAGES = 20;
const MAX_SESSIONS_PAGES = 20;
const ANALYTICS_WINDOW_DAYS = 89;
const API_TIMEOUT_MS = 20_000;
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * Saved Devin Cloud setup (`<configDir>/devin-cloud.json`, mode 0600).
 * Persisted so 15-minute background syncs work without shell env vars.
 * Environment variables always take precedence over saved values.
 */
export interface DevinCloudConfig {
  /** Use local `~/.local/share/devin/credentials.toml` for `/v3/organizations/{org_id}/sessions`. */
  useLocalCliCredentials?: boolean;
  /** Devin Personal Access Token or Service User key (`cog_...`). */
  apiKey?: string;
  /** Devin/Windsurf Analytics v2alpha service key (exact tokens on DOLLARS teams). */
  analyticsServiceKey?: string;
  /** Organization ID (`org-...`). */
  orgId?: string;
  /** User ID (`user-...`) to scope org session/analytics queries to this user. */
  userId?: string;
  /** Optional Enterprise service user ID (`service-user-...`). */
  serviceUserId?: string;
  /** Custom USD-per-ACU conversion rate (default $2.00/ACU). */
  acuUsd?: number;
  /** Custom Devin v3 API base URL. */
  apiUrl?: string;
  /** Custom Analytics v2alpha base URL. */
  analyticsApiUrl?: string;
  /** Non-secret cached display name for `setup-devin --status`. */
  userName?: string;
  configuredAt?: number;
}

export function devinCloudConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WHOBURNEDMORE_CONFIG_DIR?.trim();
  const dir = override || join(env.HOME || env.USERPROFILE || homedir(), ".config", "whoburnedmore");
  return join(dir, "devin-cloud.json");
}

export function loadDevinCloudConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath?: string,
): DevinCloudConfig | null {
  const file = configPath ?? devinCloudConfigPath(env);
  if (!existsSync(file)) return null;
  try {
    const raw = readTextFileSyncCapped(file, MAX_CONFIG_BYTES);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const cfg: DevinCloudConfig = {};
    if (parsed.useLocalCliCredentials === true) cfg.useLocalCliCredentials = true;
    if (typeof parsed.apiKey === "string" && parsed.apiKey.trim()) cfg.apiKey = parsed.apiKey.trim();
    if (typeof parsed.analyticsServiceKey === "string" && parsed.analyticsServiceKey.trim()) {
      cfg.analyticsServiceKey = parsed.analyticsServiceKey.trim();
    }
    if (typeof parsed.orgId === "string" && parsed.orgId.trim()) cfg.orgId = parsed.orgId.trim();
    if (typeof parsed.userId === "string" && parsed.userId.trim()) cfg.userId = parsed.userId.trim();
    if (typeof parsed.serviceUserId === "string" && parsed.serviceUserId.trim()) {
      cfg.serviceUserId = parsed.serviceUserId.trim();
    }
    if (typeof parsed.acuUsd === "number" && Number.isFinite(parsed.acuUsd) && parsed.acuUsd > 0 && parsed.acuUsd <= 1000) {
      cfg.acuUsd = parsed.acuUsd;
    }
    if (typeof parsed.apiUrl === "string" && parsed.apiUrl.trim()) cfg.apiUrl = parsed.apiUrl.trim();
    if (typeof parsed.analyticsApiUrl === "string" && parsed.analyticsApiUrl.trim()) {
      cfg.analyticsApiUrl = parsed.analyticsApiUrl.trim();
    }
    if (typeof parsed.userName === "string" && parsed.userName.trim()) {
      cfg.userName = parsed.userName.trim();
    }
    if (typeof parsed.configuredAt === "number" && Number.isFinite(parsed.configuredAt)) {
      cfg.configuredAt = parsed.configuredAt;
    }
    return Object.keys(cfg).length > 0 ? cfg : null;
  } catch {
    return null;
  }
}

export function saveDevinCloudConfig(
  config: DevinCloudConfig,
  env: NodeJS.ProcessEnv = process.env,
  configPath?: string,
): boolean {
  const file = configPath ?? devinCloudConfigPath(env);
  return writePrivateFileAtomic(file, JSON.stringify(config, null, 2) + "\n", MAX_CONFIG_BYTES);
}

export function clearDevinCloudConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath?: string,
): boolean {
  const file = configPath ?? devinCloudConfigPath(env);
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface DevinCliCredentials {
  apiKey: string;
  devinApiUrl: string;
  apiServerUrl: string;
  filePath: string;
}

/** Read Devin CLI's saved session token from `~/.local/share/devin/credentials.toml`. */
export function readDevinCliCredentials(
  env: NodeJS.ProcessEnv = process.env,
): DevinCliCredentials | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "devin", "credentials.toml"),
  ];
  if (platform() === "win32") {
    candidates.unshift(
      join(env.APPDATA ?? join(home, "AppData", "Roaming"), "devin", "credentials.toml"),
    );
  }
  for (const filePath of [...new Set(candidates)]) {
    const raw = readTextFileSyncCapped(filePath, MAX_CONFIG_BYTES);
    if (!raw) continue;
    const keyMatch = raw.match(/^\s*windsurf_api_key\s*=\s*"([^"]+)"/m);
    if (!keyMatch?.[1]) continue;
    const devinApiMatch = raw.match(/^\s*devin_api_url\s*=\s*"([^"]+)"/m);
    const serverMatch = raw.match(/^\s*api_server_url\s*=\s*"([^"]+)"/m);
    return {
      apiKey: keyMatch[1].trim(),
      devinApiUrl: devinApiMatch?.[1]?.trim() || DEFAULT_DEVIN_API_URL,
      apiServerUrl: serverMatch?.[1]?.trim() || DEFAULT_ANALYTICS_API_URL,
      filePath,
    };
  }
  return null;
}

function nonNegInt(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function nonNegNum(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Parse `WHOBURNEDMORE_DEVIN_ACU_USD` or saved `acuUsd`, falling back to `DEFAULT_DEVIN_ACU_USD`. */
export function resolveDevinAcuUsd(
  env: NodeJS.ProcessEnv = process.env,
  saved?: DevinCloudConfig | null,
): number {
  const raw = env.WHOBURNEDMORE_DEVIN_ACU_USD?.trim();
  if (raw) {
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0 && v <= 1000) return v;
  }
  if (
    saved?.acuUsd !== undefined &&
    Number.isFinite(saved.acuUsd) &&
    saved.acuUsd > 0 &&
    saved.acuUsd <= 1000
  ) {
    return saved.acuUsd;
  }
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

/** Collect Devin Cloud sessions + entries strictly from local `acp-messages/*.db` caches. */
export function collectDevinCloudLocalSessions(opts: {
  acpMessagesDirs?: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
} = {}): { sessions: ParsedDevinCloudSession[]; found: boolean } {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
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

  return { sessions, found: foundCloudDb };
}

/** Collect Devin Cloud usage strictly from local Devin Desktop `acp-messages/*.db` caches. */
export function collectDevinCloudLocal(opts: {
  acpMessagesDirs?: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
  acuUsd?: number;
} = {}): { entries: DailyUsageEntry[]; found: boolean } {
  const env = opts.env ?? process.env;
  const acuUsd = opts.acuUsd ?? resolveDevinAcuUsd(env);
  const { sessions, found } = collectDevinCloudLocalSessions(opts);
  return {
    entries: aggregateDevinCloudSessions(sessions, acuUsd),
    found,
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

export interface DevinSelfInfo {
  principalType: string;
  userId?: string;
  userName?: string;
  orgId?: string;
  serviceUserId?: string;
  serviceUserName?: string;
}

/** Probe `GET /v3/self` with a Devin CLI token, PAT (`cog_`), or service user key. */
export async function fetchDevinSelf(
  token: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<DevinSelfInfo> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_DEVIN_API_URL).replace(/\/+$/, "");
  const res = await fetchFn(`${baseUrl}/v3/self`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: "error",
  });
  if (!res.ok) {
    throw new Error(`devin /v3/self failed (HTTP ${res.status})`);
  }
  const body = await readJsonResponseCapped<Record<string, unknown>>(res, MAX_API_PAGE_BYTES);
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  return {
    principalType: str(body.principal_type) ?? "unknown",
    userId: str(body.user_id),
    userName: str(body.user_name),
    orgId: str(body.devin_sessions_org_id) ?? str(body.primary_billing_org_id) ?? str(body.org_id),
    serviceUserId: str(body.service_user_id),
    serviceUserName: str(body.service_user_name),
  };
}

export interface DevinV3SessionItem {
  session_id?: string;
  created_at?: number | string;
  updated_at?: number | string;
  acus_consumed?: number;
  on_demand_usage?: number | null;
  devin_mode?: string | null;
  selected_devin_mode?: string | null;
  user_id?: string | null;
}

function normalizeDevinSessionKey(sessionId: string): string {
  const trimmed = sessionId.trim();
  return trimmed.startsWith("devin-") ? trimmed : `devin-${trimmed}`;
}

function resolveV3SessionModel(item: DevinV3SessionItem): string {
  const raw = (item.selected_devin_mode ?? item.devin_mode ?? "").trim();
  if (!raw) return DEVIN_CLOUD_TOOL;
  const lower = raw.toLowerCase();
  if (lower === "normal" || lower === "fast" || lower === "ultra" || lower === "lite" || isDevinRoutingMode(lower)) {
    return DEVIN_CLOUD_TOOL;
  }
  return raw;
}

/** Fetch paginated org sessions (`GET /v3/organizations/{org_id}/sessions`). */
export async function fetchDevinV3Sessions(
  token: string,
  orgId: string,
  opts: {
    baseUrl?: string;
    userId?: string;
    maxPages?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DevinV3SessionItem[]> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_DEVIN_API_URL).replace(/\/+$/, "");
  const maxPages = opts.maxPages ?? MAX_SESSIONS_PAGES;
  const all: DevinV3SessionItem[] = [];
  let after: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${baseUrl}/v3/organizations/${encodeURIComponent(orgId)}/sessions`);
    url.searchParams.set("first", "100");
    if (opts.userId) url.searchParams.set("user_ids", opts.userId);
    if (after) url.searchParams.set("after", after);

    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) {
      throw new Error(`devin v3 sessions page ${page} failed (HTTP ${res.status})`);
    }
    const body = await readJsonResponseCapped<{
      items?: DevinV3SessionItem[];
      has_next_page?: boolean;
      end_cursor?: string | null;
    }>(res, MAX_API_PAGE_BYTES);
    if (Array.isArray(body.items)) all.push(...body.items);
    if (!body.has_next_page || !body.end_cursor) {
      after = null;
      break;
    }
    after = body.end_cursor;
  }
  return all;
}

/**
 * Merge local `acp-messages/*.db` Cloud sessions with `/v3/organizations/{org_id}/sessions`
 * at the session level so no session is double-counted and the richer source wins
 * per session (local `acp-messages` supplies ACUs on self-serve Max/Pro where
 * v3 reports `acus_consumed: 0`; v3 supplies ACUs / `on_demand_usage` for
 * webapp/CLI/Slack sessions not opened in Devin Desktop).
 */
export function mergeDevinCloudLocalAndV3Sessions(
  localSessions: readonly ParsedDevinCloudSession[],
  v3Sessions: readonly DevinV3SessionItem[],
  acuUsd: number = DEFAULT_DEVIN_ACU_USD,
  now: number = Date.now(),
): DailyUsageEntry[] {
  // Normalize local session keys and keep the highest-ACU snapshot per session.
  const localByKey = new Map<string, ParsedDevinCloudSession>();
  for (const s of localSessions) {
    const key = s.sessionKey.startsWith("devin-") ? s.sessionKey : s.sessionKey;
    const prev = localByKey.get(key);
    if (!prev || s.totalAcus > prev.totalAcus) {
      localByKey.set(key, s);
    }
  }

  const byDateModel = new Map<string, { date: string; model: string; costUSD: number }>();
  const addCost = (date: string, model: string, usd: number) => {
    if (usd <= 0) return;
    const k = `${date}|${model}`;
    const acc = byDateModel.get(k) ?? { date, model, costUSD: 0 };
    acc.costUSD += usd;
    byDateModel.set(k, acc);
  };

  const consumedLocalKeys = new Set<string>();

  for (const item of v3Sessions) {
    if (!item || typeof item.session_id !== "string" || !item.session_id.trim()) continue;
    const key = normalizeDevinSessionKey(item.session_id);
    const local = localByKey.get(key);
    const apiAcuUsd = nonNegNum(item.acus_consumed) * acuUsd;
    const apiOnDemandUsd = nonNegNum(item.on_demand_usage);
    const apiUsd = Math.max(apiAcuUsd, apiOnDemandUsd);
    const localUsd = local ? local.totalAcus * acuUsd : 0;

    if (local && localUsd >= apiUsd) {
      // Keep local per-day ACU deltas (more accurate date attribution & non-zero on Max/Pro).
      continue;
    }
    if (apiUsd > 0) {
      const ms = toEpochMs(item.updated_at) ?? toEpochMs(item.created_at);
      const date = ms !== null ? localUsageDate(ms, now) : null;
      if (!date) continue;
      if (local) consumedLocalKeys.add(key);
      const model = resolveV3SessionModel(item);
      addCost(date, model, apiUsd);
    }
  }

  for (const [key, s] of localByKey.entries()) {
    if (consumedLocalKeys.has(key)) continue;
    for (const [date, acus] of s.acusByDate.entries()) {
      addCost(date, s.model, acus * acuUsd);
    }
  }

  const entries: DailyUsageEntry[] = [];
  for (const row of byDateModel.values()) {
    const costUSD = Number(row.costUSD.toFixed(6));
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

export interface CollectDevinCloudOpts {
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  acpMessagesDirs?: string[];
  configPath?: string;
  now?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Best-effort Devin Cloud collection:
 *  1. Analytics v2alpha API (`DEVIN_ANALYTICS_SERVICE_KEY` or saved config), when online
 *  2. Enterprise v3 daily consumption API (`DEVIN_API_KEY` or saved config), when online
 *  3. Local Devin Desktop `acp-messages/*.db` cloud caches, merged with v3 org
 *     sessions when `apiKey` or `useLocalCliCredentials` is configured and online
 */
export async function collectDevinCloud(
  opts: CollectDevinCloudOpts = {},
): Promise<{ entries: DailyUsageEntry[]; found: boolean }> {
  const env = opts.env ?? process.env;
  if (env.WHOBURNEDMORE_DEVIN_CLOUD === "0") {
    return { entries: [], found: false };
  }
  const now = opts.now ?? Date.now();
  const saved = loadDevinCloudConfig(env, opts.configPath);
  const acuUsd = resolveDevinAcuUsd(env, saved);

  const analyticsKey = env.DEVIN_ANALYTICS_SERVICE_KEY?.trim() || saved?.analyticsServiceKey;
  const analyticsBaseUrl = env.DEVIN_ANALYTICS_API_URL?.trim() || saved?.analyticsApiUrl;
  const devinApiKey = env.DEVIN_API_KEY?.trim() || saved?.apiKey;
  const devinApiUrl = env.DEVIN_API_URL?.trim() || saved?.apiUrl;
  const serviceUserId = env.DEVIN_SERVICE_USER_ID?.trim() || saved?.serviceUserId;
  const userId = env.DEVIN_USER_ID?.trim() || saved?.userId;
  const orgId = env.DEVIN_ORG_ID?.trim() || saved?.orgId || readDevinOrgId(env) || undefined;

  if (!opts.offline) {
    if (analyticsKey) {
      try {
        const rows = await fetchDevinAnalytics(analyticsKey, {
          baseUrl: analyticsBaseUrl || undefined,
          userId: userId || undefined,
          now,
          fetchImpl: opts.fetchImpl,
        });
        const entries = mapDevinAnalyticsRows(rows, acuUsd, now);
        if (entries.length > 0) return { entries, found: true };
      } catch {
        /* fall through to v3 API or local cache */
      }
    }

    if (devinApiKey && (serviceUserId || orgId)) {
      try {
        const items = await fetchDevinV3Consumption(devinApiKey, {
          baseUrl: devinApiUrl || undefined,
          orgId: serviceUserId ? undefined : orgId,
          serviceUserId: serviceUserId || undefined,
          fetchImpl: opts.fetchImpl,
        });
        const entries = mapDevinV3Consumption(items, acuUsd, now);
        if (entries.length > 0) return { entries, found: true };
      } catch {
        /* 403 on non-Enterprise plans or transient error — fall through to sessions + local cache */
      }
    }
  }

  let localSessions: ParsedDevinCloudSession[] = [];
  let foundLocal = false;
  try {
    const local = collectDevinCloudLocalSessions({
      acpMessagesDirs: opts.acpMessagesDirs,
      env,
      now,
    });
    localSessions = local.sessions;
    foundLocal = local.found;
  } catch {
    /* keep going */
  }

  let v3Sessions: DevinV3SessionItem[] = [];
  if (!opts.offline) {
    let sessionToken = devinApiKey;
    let sessionApiUrl = devinApiUrl;
    if (!sessionToken && saved?.useLocalCliCredentials) {
      const cliCreds = readDevinCliCredentials(env);
      if (cliCreds) {
        sessionToken = cliCreds.apiKey;
        sessionApiUrl = sessionApiUrl || cliCreds.devinApiUrl;
      }
    }
    if (sessionToken) {
      try {
        let resolvedOrg = orgId;
        let resolvedUser = userId;
        if (!resolvedOrg || !resolvedUser) {
          const self = await fetchDevinSelf(sessionToken, {
            baseUrl: sessionApiUrl || undefined,
            fetchImpl: opts.fetchImpl,
          });
          resolvedOrg = resolvedOrg || self.orgId;
          resolvedUser = resolvedUser || self.userId;
        }
        if (resolvedOrg) {
          v3Sessions = await fetchDevinV3Sessions(sessionToken, resolvedOrg, {
            baseUrl: sessionApiUrl || undefined,
            userId: resolvedUser || undefined,
            fetchImpl: opts.fetchImpl,
          });
        }
      } catch {
        /* fall through to local sessions only */
      }
    }
  }

  const entries = mergeDevinCloudLocalAndV3Sessions(localSessions, v3Sessions, acuUsd, now);
  return {
    entries,
    found: foundLocal || entries.length > 0,
  };
}
