import { afterEach, describe, expect, it, vi } from "vitest";

import type { Summary } from "../src/protocol.js";
import {
  DEFAULT_WATCH_INTERVALS,
  FixedWindowCoalescer,
  shouldForceLimitDiscovery,
  stableSummarySignature,
  watchIntervals,
} from "../src/watch-policy.js";

function summary(generatedAt: string, totalTokens = 10): Summary {
  return {
    generatedAt,
    today: { totalTokens, costUSD: 0 },
    week: { totalTokens, costUSD: 0 },
    days: [],
    byToolToday: [],
    byTool14d: [],
    topModelsToday: [],
    toolsFound: [],
    sessionsToday: [],
    partial: false,
  };
}

describe("watch scheduling policy", () => {
  afterEach(() => vi.useRealTimers());

  it("uses idle-efficient defaults while preserving bounded fallbacks", () => {
    expect(watchIntervals({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_WATCH_INTERVALS);
    expect(DEFAULT_WATCH_INTERVALS).toEqual({
      debounceMs: 1_500,
      slowMs: 300_000,
      watchRescanMs: 60_000,
      nativePollMs: 30_000,
      limitsPollMs: 5_000,
      heartbeatMs: 30_000,
    });
  });

  it("accepts safe environment overrides and rejects hot-loop values", () => {
    expect(watchIntervals({
      BURNBAR_DEBOUNCE_MS: "300",
      BURNBAR_NATIVE_POLL_MS: "900",
      BURNBAR_LIMITS_POLL_MS: "49",
    } as NodeJS.ProcessEnv)).toMatchObject({
      debounceMs: 300,
      nativePollMs: 900,
      limitsPollMs: 5_000,
    });
  });

  it("rediscovers limit files only when a filesystem entry is created or removed", () => {
    expect(shouldForceLimitDiscovery("rename")).toBe(true);
    expect(shouldForceLimitDiscovery("change")).toBe(false);
    expect(shouldForceLimitDiscovery(undefined)).toBe(false);
  });

  it("coalesces from the first event instead of starving under continuous writes", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const coalescer = new FixedWindowCoalescer(300, fired);

    coalescer.trigger();
    vi.advanceTimersByTime(200);
    coalescer.trigger();
    vi.advanceTimersByTime(100);

    expect(fired).toHaveBeenCalledTimes(1);
    coalescer.trigger();
    vi.advanceTimersByTime(300);
    expect(fired).toHaveBeenCalledTimes(2);
  });

  it("cancels an armed callback", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const coalescer = new FixedWindowCoalescer(300, fired);
    coalescer.trigger();
    coalescer.cancel();
    vi.advanceTimersByTime(300);
    expect(fired).not.toHaveBeenCalled();
  });

  it("ignores generatedAt but detects user-visible summary changes", () => {
    expect(stableSummarySignature(summary("a"))).toBe(stableSummarySignature(summary("b")));
    expect(stableSummarySignature(summary("a", 10))).not.toBe(
      stableSummarySignature(summary("a", 11)),
    );
  });
});
