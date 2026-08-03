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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveCodexSessionsDir } from "../../../src/native/codex.js";
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
    resetsAt = w.resets_at;
  } else {
    const rel = num(w.resets_in_seconds);
    if (rel !== null && eventTs !== null) resetsAt = new Date(eventTs + rel * 1000).toISOString();
  }
  if (usedPercent === null && windowMinutes === null && resetsAt === null) return null;
  return { label, usedPercent, windowMinutes, resetsAt };
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
      latest = {
        present: true,
        capturedAt: eventTs !== null ? new Date(eventTs).toISOString() : null,
        planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
        limitId: typeof rl.limit_id === "string" ? rl.limit_id : null,
        primary: parseWindow(rl.primary, "session", eventTs),
        secondary: parseWindow(rl.secondary, "weekly", eventTs),
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

/** Read current codex limits from the local sessions dir (never throws). */
export function readCodexLimits(env: NodeJS.ProcessEnv = process.env): CodexLimits {
  try {
    const root = resolveCodexSessionsDir(env);
    for (const file of newestSessionFiles(root)) {
      const limits = parseCodexLimitLines(readFileSync(file, "utf8").split("\n"));
      if (limits.present) return limits;
    }
  } catch {
    /* missing dir / unreadable — fall through */
  }
  return EMPTY;
}
