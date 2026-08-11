import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { BlockEntry, DailyUsageEntry } from "./shared.js";
import { readJsonResponseCapped } from "./http-bounds.js";
import { localUsageDate } from "./native/usage-date.js";
import { collectCursorViaTokscale } from "./tokscale.js";

// Cursor doesn't write ccusage-readable local logs — its usage lives behind the
// cursor.com dashboard. But the desktop app caches a session token locally, and
// the dashboard's own (unofficial) API returns per-event token + cost data. We
// read the token locally and call that API directly: the token NEVER leaves the
// machine, only the same daily aggregates every other source produces do. Best
// effort throughout — any failure (Cursor not installed, not signed in, API
// change) just yields no Cursor data, never an error.

const EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const MAX_CURSOR_PAGE_BYTES = 4 * 1024 * 1024;

/** Path to Cursor's globalStorage SQLite DB, per platform; null if absent. */
export function cursorDbPath(): string | null {
  const home = homedir();
  const os = platform();
  const p =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
      : os === "win32"
        ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb")
        : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
  return existsSync(p) ? p : null;
}

function trustedSqliteBinaries(): string[] {
  const candidates =
    platform() === "darwin"
      ? ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]
      : platform() === "linux"
        ? ["/usr/bin/sqlite3", "/usr/local/bin/sqlite3"]
        : [];
  const trusted: string[] = [];
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      const stat = statSync(resolved);
      if (stat.isFile() && (stat.mode & 0o022) === 0) trusted.push(resolved);
    } catch {
      // Not installed or not a trustworthy regular file.
    }
  }
  return [...new Set(trusted)];
}

/** Read cursorAuth/accessToken — built-in node:sqlite (Node 22.5+), else a
 * trusted absolute sqlite3 binary. Never resolve an executable through PATH. */
export function readCursorToken(db: string): string | null {
  const require = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(db, { readOnly: true });
    const row = d
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/accessToken") as { value?: string } | undefined;
    d.close();
    if (row?.value) return String(row.value);
  } catch {
    // node:sqlite unavailable or locked — fall back to the sqlite3 binary.
  }
  for (const sqlite3 of trustedSqliteBinaries()) {
    try {
      const res = spawnSync(
        sqlite3,
        [db, "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken';"],
        { encoding: "utf8", timeout: 10_000 },
      );
      const out = res.stdout?.trim();
      if (res.status === 0 && out) return out;
    } catch {
      /* try the next trusted location */
    }
  }
  return null;
}

/** Build the dashboard cookie from the JWT (value form: `<sub>::<jwt>`). */
export function cursorCookie(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    ) as { sub?: string };
    if (!json.sub) return null;
    return `WorkosCursorSessionToken=${json.sub}%3A%3A${token}`;
  } catch {
    return null;
  }
}

interface CursorEvent {
  timestamp?: string;
  model?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number;
  };
}

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Fold Cursor usage events into daily (date × model) entries tagged tool
 * "cursor", plus hour-of-day blocks for the peak-hours view. Pure + tested.
 */
export function mapCursorEvents(events: CursorEvent[]): {
  entries: DailyUsageEntry[];
  blocks: BlockEntry[];
} {
  const byDay = new Map<string, DailyUsageEntry>();
  const byHour = new Map<string, BlockEntry>();
  for (const e of events) {
    const tu = e.tokenUsage;
    const ms = Number(e.timestamp);
    if (!tu || !Number.isFinite(ms)) continue;
    const d = new Date(ms);
    // Bucket by LOCAL calendar day, matching the native readers and ccusage —
    // a UTC slice here put late-evening usage on tomorrow's row for anyone
    // east of UTC, splitting the same physical day across two board days.
    const date = localUsageDate(ms);
    if (!date) continue;
    const model = e.model || "cursor";
    const input = num(tu.inputTokens);
    const output = num(tu.outputTokens);
    const cacheWrite = num(tu.cacheWriteTokens);
    const cacheRead = num(tu.cacheReadTokens);
    const cost = Math.max(0, (Number(tu.totalCents) || 0) / 100);
    const total = input + output + cacheWrite + cacheRead;
    if (total === 0 && cost === 0) continue;

    const key = `${date}|${model}`;
    const day =
      byDay.get(key) ??
      ({
        date,
        tool: "cursor",
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0,
        origin: "cli",
        verified: false,
      } satisfies DailyUsageEntry);
    day.inputTokens += input;
    day.outputTokens += output;
    day.cacheCreationTokens += cacheWrite;
    day.cacheReadTokens += cacheRead;
    day.costUSD += cost;
    byDay.set(key, day);

    const hour = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()),
    ).toISOString();
    const blk = byHour.get(hour) ?? { startTime: hour, totalTokens: 0, costUSD: 0 };
    blk.totalTokens += total;
    blk.costUSD += cost;
    byHour.set(hour, blk);
  }
  const entries = [...byDay.values()].map((e) => ({
    ...e,
    costUSD: Number(e.costUSD.toFixed(4)),
  }));
  const blocks = [...byHour.values()].map((b) => ({
    ...b,
    costUSD: Number(b.costUSD.toFixed(4)),
  }));
  return { entries, blocks };
}

export async function fetchCursorEvents(
  cookie: string,
  maxPages = 30,
  pageSize = 500,
): Promise<CursorEvent[]> {
  const all: CursorEvent[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://cursor.com",
        Cookie: cookie,
      },
      body: JSON.stringify({ page, pageSize }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    // Data consistency: a mid-pagination failure must NOT yield a partial set.
    // Returning fewer events here would make the server overwrite recent-day
    // Cursor totals with a smaller number, so the dashboard shrinks then
    // recovers run-to-run. Throw instead — collectCursor() catches it and the
    // run reports no Cursor data, leaving the prior complete totals untouched.
    if (!res.ok) {
      throw new Error(`cursor usage page ${page} failed (HTTP ${res.status})`);
    }
    const body = await readJsonResponseCapped<{ usageEventsDisplay?: CursorEvent[] }>(
      res,
      MAX_CURSOR_PAGE_BYTES,
    );
    const batch = body.usageEventsDisplay ?? [];
    all.push(...batch);
    // A short page is the natural end of data (not an error) — stop cleanly.
    if (batch.length < pageSize) break;
  }
  return all;
}

/**
 * Best-effort Cursor collection: locate the local token, call the dashboard
 * API, fold into entries + blocks. Returns empty on any failure.
 */
export async function collectCursor(opts?: { offline?: boolean }): Promise<{
  entries: DailyUsageEntry[];
  blocks: BlockEntry[];
  found: boolean;
}> {
  try {
    const db = cursorDbPath();
    const token = db ? readCursorToken(db) : null;
    const cookie = token ? cursorCookie(token) : null;
    // In offline mode (`--local`) we must never send the local Cursor session
    // token to cursor.com — skip the dashboard fetch and fall through to the
    // purely-local tokscale cache below.
    if (cookie && !opts?.offline) {
      const events = await fetchCursorEvents(cookie);
      const { entries, blocks } = mapCursorEvents(events);
      if (entries.length > 0) return { entries, blocks, found: true };
    }
  } catch {
    // Primary path failed (Cursor not installed/signed in, or the dashboard
    // endpoint changed) — fall through to the tokscale fallback below.
  }

  // Fallback: the community-maintained `tokscale` CLI, reading its synced Cursor
  // cache. Resilient to Cursor API changes. It is NOT a bundled dependency (it
  // pulled in a deprecated, vuln-flagged `glob` via a heavy TUI tree that printed
  // an npm-deprecation warning on every `npx whoburnedmore`), so this is a no-op
  // unless the user has installed it globally (`npm i -g tokscale`) and run
  // `tokscale cursor login` + `sync`. The primary path above needs none of that.
  try {
    const entries = collectCursorViaTokscale();
    if (entries.length > 0) return { entries, blocks: [], found: true };
  } catch {
    /* tokscale missing or no data — give up quietly */
  }

  return { entries: [], blocks: [], found: false };
}
