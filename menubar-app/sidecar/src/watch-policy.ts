import type { Summary } from "./protocol.js";

function envInterval(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  return Number.isFinite(value) && value >= 50 ? value : fallback;
}

export const DEFAULT_WATCH_INTERVALS = {
  debounceMs: 1_500,
  slowMs: 5 * 60_000,
  watchRescanMs: 60_000,
  nativePollMs: 30_000,
  limitsPollMs: 5_000,
  heartbeatMs: 30_000,
} as const;

export interface WatchIntervals {
  debounceMs: number;
  slowMs: number;
  watchRescanMs: number;
  nativePollMs: number;
  limitsPollMs: number;
  heartbeatMs: number;
}

export function watchIntervals(env: NodeJS.ProcessEnv = process.env): WatchIntervals {
  return {
    debounceMs: envInterval(env, "BURNBAR_DEBOUNCE_MS", DEFAULT_WATCH_INTERVALS.debounceMs),
    slowMs: envInterval(env, "BURNBAR_SLOW_INTERVAL_MS", DEFAULT_WATCH_INTERVALS.slowMs),
    watchRescanMs: envInterval(
      env,
      "BURNBAR_WATCH_RESCAN_MS",
      DEFAULT_WATCH_INTERVALS.watchRescanMs,
    ),
    nativePollMs: envInterval(
      env,
      "BURNBAR_NATIVE_POLL_MS",
      DEFAULT_WATCH_INTERVALS.nativePollMs,
    ),
    limitsPollMs: envInterval(
      env,
      "BURNBAR_LIMITS_POLL_MS",
      DEFAULT_WATCH_INTERVALS.limitsPollMs,
    ),
    heartbeatMs: DEFAULT_WATCH_INTERVALS.heartbeatMs,
  };
}

/** Appends are `change` events and only need cached tail reads. A `rename`
 * means the candidate set itself may have changed, so directory discovery is
 * warranted. This keeps active transcripts from retraversing history. */
export function shouldForceLimitDiscovery(eventType: string | undefined): boolean {
  return eventType === "rename";
}

/**
 * Coalesce a burst relative to its first event. A traditional debounce that
 * resets on every write can starve forever while an agent continuously appends
 * to a transcript.
 */
export class FixedWindowCoalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly callback: () => void,
  ) {}

  trigger(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.callback();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** `generatedAt` is collection metadata, not a user-visible data change. */
export function stableSummarySignature(summary: Summary): string {
  const { generatedAt: _, ...stable } = summary;
  return JSON.stringify(stable);
}
