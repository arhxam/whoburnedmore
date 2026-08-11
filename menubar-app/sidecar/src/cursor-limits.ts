/**
 * Cursor plan usage — best-effort, over the network, using the SAME local
 * session-token approach as `src/cursor.ts`'s dashboard reader
 * (the desktop app's globalStorage SQLite DB → `cursorAuth/accessToken` → a
 * `WorkosCursorSessionToken` cookie). We reuse those exact helpers rather than
 * re-deriving the token logic, so there's exactly one place that knows how to
 * read Cursor's local credential.
 *
 * The legacy per-model usage endpoint (`GET /api/usage`, cookie-authenticated)
 * returns an object keyed by model name plus a `startOfMonth` field, e.g.
 * `{ "gpt-4": { numRequests, maxRequestUsage, ... }, startOfMonth: "..." }`.
 * This is unofficial and undocumented, so parsing is defensive throughout:
 * any unexpected shape, network failure, or missing local token yields
 * `{ present: false, ... }` rather than throwing or fabricating a number.
 */
import { cursorCookie, cursorDbPath, readCursorToken } from "../../../src/cursor.js";
import { readJsonResponseCapped } from "../../../src/http-bounds.js";
import type { CursorLimits } from "./protocol.js";

const USAGE_URL = "https://www.cursor.com/api/usage";
const MAX_CURSOR_USAGE_BYTES = 1024 * 1024;

export const EMPTY_CURSOR_LIMITS: CursorLimits = {
  present: false,
  planPercent: null,
  used: null,
  limit: null,
  renewsAt: null,
};

/** Preserve the last successful dashboard sample across network/auth/read
 * failures. When its known renewal boundary passes, advance to an explicit
 * zero rather than displaying stale usage indefinitely. */
export function reconcileCursorLimits(
  previous: CursorLimits | null,
  observed: CursorLimits,
  now: number = Date.now(),
): CursorLimits {
  const source = observed.present
    ? observed
    : previous?.present
      ? previous
      : observed;
  if (!source.present || source.renewsAt === null) return source;
  const renewal = Date.parse(source.renewsAt);
  if (!Number.isFinite(renewal) || renewal > now) return source;
  return {
    ...source,
    planPercent: 0,
    used: 0,
    renewsAt: null,
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One model's usage row inside the `/api/usage` response. */
function isUsageRow(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `startOfMonth` + 1 calendar month, as an ISO string (the plan's reset cadence). */
function addOneMonthISO(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const next = new Date(d);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

/**
 * Map the parsed `/api/usage` JSON body into `CursorLimits`. Pure + no
 * network — this is what the unit tests exercise against fixtures. Sums
 * `numRequests`/`maxRequestUsage` across every per-model key found; any key
 * that isn't a usage-row object (e.g. `startOfMonth`) is skipped rather than
 * throwing.
 */
export function mapCursorUsageResponse(json: unknown): CursorLimits {
  if (!isUsageRow(json)) return EMPTY_CURSOR_LIMITS;

  let used = 0;
  let limit = 0;
  let sawUsage = false;
  let sawLimit = false;
  for (const [key, value] of Object.entries(json)) {
    if (key === "startOfMonth" || key === "renewalDate") continue;
    if (!isUsageRow(value)) continue;
    const requests = num(value.numRequests ?? value.numRequestsTotal);
    if (requests !== null) {
      used += requests;
      sawUsage = true;
    }
    const max = num(value.maxRequestUsage);
    if (max !== null) {
      limit += max;
      sawLimit = true;
    }
  }
  if (!sawUsage) return EMPTY_CURSOR_LIMITS;

  const startOfMonth = typeof json.startOfMonth === "string" ? json.startOfMonth : null;
  return {
    present: true,
    planPercent: sawLimit && limit > 0 ? Number(((used / limit) * 100).toFixed(1)) : null,
    used,
    limit: sawLimit && limit > 0 ? limit : null,
    renewsAt: startOfMonth ? addOneMonthISO(startOfMonth) : null,
  };
}

/**
 * Fetch + map current Cursor plan usage. Never throws: any failure (Cursor
 * not installed/signed in, network error, endpoint shape change) yields
 * `{ present: false, ... }`. `env` is accepted for signature parity with the
 * rest of the sidecar's env-threaded functions; the underlying token lookup
 * (like the CLI's) reads the fixed platform-specific globalStorage path.
 */
export async function fetchCursorLimits(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CursorLimits> {
  void env;
  try {
    const db = cursorDbPath();
    const token = db ? readCursorToken(db) : null;
    const cookie = token ? cursorCookie(token) : null;
    if (!cookie) return EMPTY_CURSOR_LIMITS;
    const res = await fetch(USAGE_URL, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) return EMPTY_CURSOR_LIMITS;
    const json = await readJsonResponseCapped(res, MAX_CURSOR_USAGE_BYTES);
    return mapCursorUsageResponse(json);
  } catch {
    return EMPTY_CURSOR_LIMITS;
  }
}
