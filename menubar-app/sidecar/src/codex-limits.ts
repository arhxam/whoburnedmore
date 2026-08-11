/**
 * Codex "remaining usage" comes for free: every session rollout JSONL carries
 * `token_count` events with a `rate_limits` payload (primary/secondary windows
 * with used_percent + reset info, credits, plan type). No auth needed — we take
 * the newest such event from the most recently modified session files.
 *
 * Shapes seen in the wild (both must parse):
 *  - populated: {"primary":{"used_percent":12.5,"window_minutes":300,"resets_in_seconds":9000}, ...}
 *  - sparse:    {"limit_id":"codex","primary":null,"secondary":null,"credits":{...},"plan_type":"go"}
 * Reset info arrives as either `resets_in_seconds` (relative) or `resets_at`.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveCodexSessionsDirs } from "../../../src/native/codex.js";
import type { CodexLimits, WindowLimit } from "./protocol.js";

const EMPTY: CodexLimits = {
  present: false,
  capturedAt: null,
  planType: null,
  limitId: null,
  primary: null,
  secondary: null,
  creditsBalance: null,
  hasCredits: null,
  unlimited: null,
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isoFromEpochMs(epochMs: number): string | null {
  const date = new Date(epochMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseWindow(
  raw: unknown,
  label: string,
  eventTs: number | null,
): WindowLimit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const usedPercent = num(w.used_percent);
  const windowMinutes = num(w.window_minutes);
  let resetsAt: string | null = null;
  if (typeof w.resets_at === "string") {
    const absolute = Date.parse(w.resets_at);
    if (Number.isFinite(absolute)) resetsAt = w.resets_at;
  } else {
    const absolute = num(w.resets_at);
    if (absolute !== null) {
      // Current Codex emits Unix seconds; tolerate milliseconds as well so a
      // provider-side serialization change cannot turn the countdown blank.
      const epochMs = absolute >= 1_000_000_000_000 ? absolute : absolute * 1000;
      if (Number.isFinite(epochMs)) resetsAt = isoFromEpochMs(epochMs);
    }
  }
  if (resetsAt === null) {
    const rel = num(w.resets_in_seconds);
    if (rel !== null && eventTs !== null) resetsAt = isoFromEpochMs(eventTs + rel * 1000);
  }
  if (usedPercent === null && windowMinutes === null && resetsAt === null) return null;
  return { label, usedPercent, windowMinutes, resetsAt };
}

function normalizedWindows(
  primary: WindowLimit | null,
  secondary: WindowLimit | null,
): Pick<CodexLimits, "primary" | "secondary"> {
  const isWeekly = (w: WindowLimit | null) => (w?.windowMinutes ?? 0) >= 6 * 24 * 60;
  const session = [primary, secondary].find((w) => w !== null && !isWeekly(w)) ?? null;
  const weekly = [primary, secondary].find((w) => isWeekly(w)) ?? null;

  // Preserve structural meaning for older/sparse payloads without durations,
  // but classify the newer Pro shape where a lone 10,080-minute window appears
  // in `primary` and `secondary` is null.
  const normalizedPrimary = session ?? (weekly === null ? primary : null);
  const normalizedSecondary = weekly ?? secondary;
  return {
    primary: normalizedPrimary ? { ...normalizedPrimary, label: "session" } : null,
    secondary: normalizedSecondary ? { ...normalizedSecondary, label: "weekly" } : null,
  };
}

/** Parse the LAST rate_limits event out of one rollout file's lines. */
export function parseCodexLimitLines(lines: Iterable<string>): CodexLimits {
  let latest: CodexLimits = EMPTY;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('"rate_limits"')) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        timestamp?: unknown;
        payload?: { rate_limits?: unknown; info?: unknown };
      };
      const rl = (obj.payload?.rate_limits ??
        (obj.payload?.info as { rate_limits?: unknown } | undefined)?.rate_limits) as
        | Record<string, unknown>
        | undefined;
      if (typeof rl !== "object" || rl === null) continue;
      const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
      const eventTs = Number.isFinite(ts) ? ts : null;
      const credits =
        typeof rl.credits === "object" && rl.credits !== null
          ? (rl.credits as Record<string, unknown>)
          : null;
      const windows = normalizedWindows(
        parseWindow(rl.primary, "session", eventTs),
        parseWindow(rl.secondary, "weekly", eventTs),
      );
      latest = {
        present: true,
        capturedAt: eventTs !== null ? new Date(eventTs).toISOString() : null,
        planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
        limitId: typeof rl.limit_id === "string" ? rl.limit_id : null,
        primary: windows.primary,
        secondary: windows.secondary,
        creditsBalance:
          credits && typeof credits.balance === "string" ? credits.balance : null,
        hasCredits: credits && typeof credits.has_credits === "boolean" ? credits.has_credits : null,
        unlimited: credits && typeof credits.unlimited === "boolean" ? credits.unlimited : null,
      };
    } catch {
      // malformed line — keep scanning
    }
  }
  return latest;
}

/**
 * Read backwards until the newest rate-limit line is found. Active rollout
 * files can be tens of megabytes; re-reading each one every five seconds caused
 * avoidable I/O and made limit refresh compete with token collection.
 */
function readLatestLimitFromFile(file: string): CodexLimits {
  const chunkSize = 256 * 1024;
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    let end = size;
    let suffix = "";
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const buffer = Buffer.allocUnsafe(end - start);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
      // A rollout can vanish or be replaced between stat() and read(). Never
      // decode the unread portion of an unsafe buffer; retry on the next poll.
      if (bytesRead !== buffer.length) return EMPTY;
      const text = buffer.toString("utf8") + suffix;
      const lines = text.split("\n");
      suffix = start > 0 ? (lines.shift() ?? "") : "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const parsed = parseCodexLimitLines([lines[i]]);
        if (parsed.present) return parsed;
      }
      end = start;
    }
    if (suffix) return parseCodexLimitLines([suffix]);
  } catch {
    /* raced/unreadable file */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  return EMPTY;
}

function clearExpiredWindow(window: WindowLimit | null, now: number): WindowLimit | null {
  if (window?.resetsAt === null || window?.resetsAt === undefined) return window;
  const reset = Date.parse(window.resetsAt);
  if (!Number.isFinite(reset) || reset > now) return window;
  return { ...window, usedPercent: 0, resetsAt: null, forecastHitAt: null };
}

/**
 * Reconcile one poll with the last valid provider sample. A missing/unreadable
 * rollout is an observation failure, not evidence that usage became zero. Keep
 * the last-known-good value, but still advance its explicit reset boundaries so
 * an exhausted window reaches 0 on time even while Codex is rotating files.
 */
export function reconcileCodexLimits(
  previous: CodexLimits | null,
  observed: CodexLimits,
  now: number = Date.now(),
): CodexLimits {
  const source = observed.present
    ? observed
    : previous?.present
      ? previous
      : observed;
  return {
    ...source,
    primary: clearExpiredWindow(source.primary, now),
    secondary: clearExpiredWindow(source.secondary, now),
  };
}

/** Newest-first .jsonl files under the codex sessions tree (bounded walk). */
export function newestSessionFiles(root: string, max = 5): string[] {
  const files: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory() && depth < 4) walk(full, depth + 1);
        else if (st.isFile() && name.endsWith(".jsonl"))
          files.push({ path: full, mtime: st.mtimeMs });
      } catch {
        /* raced file — skip */
      }
    }
  };
  walk(root, 0);
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((f) => f.path);
}

/**
 * Read current Codex limits from active and archived rollouts (never throws).
 * Codex moves a completed rollout into `archived_sessions`; scanning both roots
 * lets a freshly launched BurnBar restore the last provider sample immediately
 * instead of briefly showing no usage until Codex emits another message.
 */
export function readCodexLimits(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): CodexLimits {
  try {
    let latest: CodexLimits | null = null;
    let latestCapturedAt = Number.NEGATIVE_INFINITY;
    const files = resolveCodexSessionsDirs(env).flatMap((root) =>
      newestSessionFiles(root, 20),
    );
    for (const file of files) {
      const limits = readLatestLimitFromFile(file);
      if (!limits.present) continue;
      const capturedAt = limits.capturedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(limits.capturedAt);
      if (latest === null || (Number.isFinite(capturedAt) && capturedAt > latestCapturedAt)) {
        latest = limits;
        latestCapturedAt = Number.isFinite(capturedAt) ? capturedAt : latestCapturedAt;
      }
    }
    if (latest) {
      return reconcileCodexLimits(null, latest, now);
    }
  } catch {
    /* missing dir / unreadable — fall through */
  }
  return EMPTY;
}
