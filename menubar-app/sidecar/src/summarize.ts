/**
 * Turn deduped daily entries into the popover's view model. Day bucketing uses
 * the LOCAL calendar day (en-CA → YYYY-MM-DD), matching the CLI readers that
 * produced the entries' date strings in the first place.
 */
import type { DailyUsageEntry, SessionEntry } from "../../../src/shared.js";
import { sanitizeMachineLabel } from "../../../src/wire-sanitize.js";

import type {
  DayPoint,
  ModelBreakdown,
  SessionSummary,
  Summary,
  ToolBreakdown,
} from "./protocol.js";

export function localDay(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA");
}

function entryTokens(e: DailyUsageEntry): number {
  return e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
}

function sessionTokens(s: SessionEntry): number {
  return s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens;
}

/**
 * A human-friendly label for a session row. `SessionEntry` carries no title —
 * only `sessionId` (ccusage's `period`/session id, often a project-path-ish
 * string or a bare uuid) — so we take the last path-ish segment of it, falling
 * back to a truncated raw id.
 */
export function sessionName(s: SessionEntry, names?: Map<string, string>): string {
  const mapped = names?.get(s.sessionId);
  if (mapped) return mapped.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64) || "session";
  const raw = s.sessionId;
  const parts = raw.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || raw;
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, "");
  return (clean.length > 24 ? clean.slice(0, 24) : clean) || "session";
}

/** The last `n` local days ending today, ascending. */
export function lastDays(n: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(localDay(d));
  }
  return out;
}

export function summarize(
  entries: DailyUsageEntry[],
  toolsFound: string[],
  partial: boolean,
  now: Date = new Date(),
  sessions: SessionEntry[] = [],
  sessionNames?: Map<string, string>,
): Summary {
  const today = localDay(now);
  const window14 = lastDays(14, now);
  const window7 = new Set(lastDays(7, now));
  const set14 = new Set(window14);

  const perDay = new Map<string, DayPoint>();
  for (const date of window14) perDay.set(date, { date, tokens: 0, costUSD: 0 });

  let todayTokens = 0;
  let todayCost = 0;
  let weekTokens = 0;
  let weekCost = 0;
  const toolToday = new Map<string, ToolBreakdown>();
  const tool14 = new Map<string, ToolBreakdown>();
  const modelToday = new Map<string, number>();

  for (const e of entries) {
    const tokens = entryTokens(e);
    const tool = sanitizeMachineLabel(e.tool, "agent", 64);
    const model = sanitizeMachineLabel(e.model, "model", 128);
    if (tokens <= 0 && e.costUSD <= 0) continue;
    if (e.date === today) {
      todayTokens += tokens;
      todayCost += e.costUSD;
      const t = toolToday.get(tool) ?? { tool, tokens: 0, costUSD: 0 };
      t.tokens += tokens;
      t.costUSD += e.costUSD;
      toolToday.set(tool, t);
      modelToday.set(model, (modelToday.get(model) ?? 0) + tokens);
    }
    if (window7.has(e.date)) {
      weekTokens += tokens;
      weekCost += e.costUSD;
    }
    if (set14.has(e.date)) {
      const day = perDay.get(e.date)!;
      day.tokens += tokens;
      day.costUSD += e.costUSD;
      const t = tool14.get(tool) ?? { tool, tokens: 0, costUSD: 0 };
      t.tokens += tokens;
      t.costUSD += e.costUSD;
      tool14.set(tool, t);
    }
  }

  const byTokens = (a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens;
  const round = (rows: ToolBreakdown[]) =>
    rows.map((r) => ({ ...r, costUSD: Number(r.costUSD.toFixed(2)) }));

  const sessionsToday: SessionSummary[] = sessions
    .filter((s) => localDay(new Date(s.lastActivity)) === today)
    .sort((a, b) => sessionTokens(b) - sessionTokens(a))
    .slice(0, 5)
    .map((s) => ({
      name: sessionName(s, sessionNames),
      tool: sanitizeMachineLabel(s.tool, "agent", 64),
      tokens: sessionTokens(s),
    }));

  return {
    generatedAt: now.toISOString(),
    today: { totalTokens: todayTokens, costUSD: Number(todayCost.toFixed(2)) },
    week: { totalTokens: weekTokens, costUSD: Number(weekCost.toFixed(2)) },
    days: window14.map((d) => {
      const p = perDay.get(d)!;
      return { ...p, costUSD: Number(p.costUSD.toFixed(2)) };
    }),
    byToolToday: round([...toolToday.values()].sort(byTokens).slice(0, 32)),
    byTool14d: round([...tool14.values()].sort(byTokens).slice(0, 32)),
    topModelsToday: [...modelToday.entries()]
      .map(([model, tokens]): ModelBreakdown => ({ model, tokens }))
      .sort(byTokens)
      .slice(0, 5),
    toolsFound: [
      ...new Set(toolsFound.map((tool) => sanitizeMachineLabel(tool, "agent", 64))),
    ].sort().slice(0, 32),
    sessionsToday,
    partial,
  };
}
