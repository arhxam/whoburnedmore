/**
 * BurnBar sidecar ⇄ Swift shell protocol: newline-delimited JSON on stdout.
 * Every line is one event object with a `type` discriminant. The Swift side
 * must tolerate unknown event types and unknown fields (forward compat).
 */

export interface DayPoint {
  /** Local calendar day, YYYY-MM-DD (same bucketing as the whoburnedmore CLI). */
  date: string;
  tokens: number;
  costUSD: number;
}

export interface ToolBreakdown {
  tool: string;
  tokens: number;
  costUSD: number;
}

export interface ModelBreakdown {
  model: string;
  tokens: number;
}

/** One of today's most active sessions/conversations (aggregate only, no content). */
export interface SessionSummary {
  name: string;
  tool: string;
  tokens: number;
}

export interface Summary {
  generatedAt: string;
  today: { totalTokens: number; costUSD: number };
  week: { totalTokens: number; costUSD: number };
  /** Last 14 local days ascending, zero-filled — sparkline-ready. */
  days: DayPoint[];
  byToolToday: ToolBreakdown[];
  byTool14d: ToolBreakdown[];
  topModelsToday: ModelBreakdown[];
  toolsFound: string[];
  /** Today's top 5 sessions by tokens (best-effort; empty when the ccusage
   *  session rollup wasn't available this run). */
  sessionsToday?: SessionSummary[];
  /** True when a reader bailed on its time budget — numbers may still be converging. */
  partial: boolean;
}

export interface WindowLimit {
  label: string;
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  /** Linear pace projection of when this window hits 100% (watch mode only). */
  forecastHitAt?: string | null;
}

export interface CodexLimits {
  present: boolean;
  capturedAt: string | null;
  planType: string | null;
  limitId: string | null;
  primary: WindowLimit | null;
  secondary: WindowLimit | null;
  creditsBalance: string | null;
  hasCredits: boolean | null;
  unlimited: boolean | null;
}

/** Cursor plan usage, best-effort via the local session cookie (network). */
export interface CursorLimits {
  present: boolean;
  planPercent: number | null;
  used: number | null;
  limit: number | null;
  renewsAt: string | null;
}

export interface Limits {
  codex: CodexLimits;
  cursor?: CursorLimits;
}

export type Event =
  | { type: "hello"; version: string; pid: number }
  | { type: "snapshot"; summary: Summary }
  | { type: "limits"; limits: Limits }
  | {
      type: "alert";
      kind: "threshold" | "reset";
      provider: string;
      level?: number;
      percent: number;
    }
  | { type: "status"; collecting: boolean; lastFullCollectAt: string | null; error?: string }
  | { type: "heartbeat"; ts: string };

export const PROTOCOL_VERSION = "1";

export function serialize(event: Event): string {
  return JSON.stringify(event);
}

/** Parse one NDJSON line; null for blank/garbage lines (never throws). */
export function parseEvent(line: string): Event | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as { type?: unknown };
    if (typeof obj !== "object" || obj === null || typeof obj.type !== "string") return null;
    return obj as Event;
  } catch {
    return null;
  }
}

export function emit(event: Event): void {
  process.stdout.write(serialize(event) + "\n");
}
