const MIN_USAGE_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const MAX_CLOCK_SKEW_MS = 2 * 86_400_000;

/**
 * Convert an epoch timestamp to a plausible local usage day.
 *
 * Local source files are external input: corrupt seconds/milliseconds values and
 * out-of-range numbers must not produce `NaN-NaN-NaN` or a pre-agent/far-future
 * date that makes the API reject the entire otherwise-valid payload.
 */
export function localUsageDate(
  ms: number,
  now: number = Date.now(),
): string | null {
  if (
    !Number.isFinite(ms) ||
    ms < MIN_USAGE_TIMESTAMP_MS ||
    ms > now + MAX_CLOCK_SKEW_MS
  ) {
    return null;
  }
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Validate a YYYY-MM-DD value from an external daily report without allowing
 * Date's rollover semantics (for example, February 31 becoming March 3). */
export function plausibleUsageDate(
  value: string,
  now: number = Date.now(),
): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const parsed = new Date(ms);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    ms >= MIN_USAGE_TIMESTAMP_MS &&
    ms <= now + MAX_CLOCK_SKEW_MS
  );
}
