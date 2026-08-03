/**
 * Pure math for "at this pace you hit the cap at 6:40 PM" and for alerting.
 * Kept runtime-free (no Date.now, no I/O) so it unit-tests exactly.
 */

export interface PercentSample {
  /** ms epoch */
  at: number;
  percent: number;
}

/**
 * Linear pace forecast: from the oldest→newest samples inside `lookbackMs`,
 * project when percent reaches 100. Returns the projected ms epoch, or null
 * when there's no meaningful upward burn (fewer than 2 samples, flat, or
 * declining — a decline means the window rolled over).
 */
export function forecastLimitHit(
  samples: PercentSample[],
  nowMs: number,
  lookbackMs = 60 * 60 * 1000,
): number | null {
  const recent = samples
    .filter((s) => nowMs - s.at <= lookbackMs && Number.isFinite(s.percent))
    .sort((a, b) => a.at - b.at);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (last.percent >= 100) return nowMs;
  const dt = last.at - first.at;
  const dp = last.percent - first.percent;
  if (dt <= 0 || dp <= 0) return null;
  const ratePerMs = dp / dt;
  if (ratePerMs <= 0) return null;
  return Math.round(last.at + (100 - last.percent) / ratePerMs);
}

export type AlertKind = "threshold" | "reset";

export interface LimitAlert {
  kind: AlertKind;
  /** The threshold crossed (80 or 95) for kind=threshold. */
  level?: number;
  percent: number;
}

export const ALERT_THRESHOLDS = [80, 95] as const;

/**
 * Rising-edge threshold detection with reset awareness. Feed consecutive
 * percent readings; emits each threshold at most once per climb, and a single
 * "reset" when the window rolls over (a drop of ≥30 points, or crossing back
 * below the lowest threshold after having been above it).
 */
export function detectAlerts(prevPercent: number | null, percent: number): LimitAlert[] {
  if (!Number.isFinite(percent)) return [];
  const alerts: LimitAlert[] = [];
  if (prevPercent !== null && Number.isFinite(prevPercent)) {
    const dropped = prevPercent - percent >= 30;
    const fellBelowAll = prevPercent >= ALERT_THRESHOLDS[0] && percent < ALERT_THRESHOLDS[0];
    if (dropped || fellBelowAll) {
      alerts.push({ kind: "reset", percent });
      return alerts;
    }
  }
  for (const level of ALERT_THRESHOLDS) {
    const wasBelow = prevPercent === null ? true : prevPercent < level;
    if (wasBelow && percent >= level) alerts.push({ kind: "threshold", level, percent });
  }
  // Never fire a threshold on the very first sample — there's no edge yet.
  if (prevPercent === null) return [];
  return alerts;
}
