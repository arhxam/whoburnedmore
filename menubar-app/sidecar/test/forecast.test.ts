import { describe, expect, it } from "vitest";

import { detectAlerts, forecastLimitHit } from "../src/forecast.js";

const MIN = 60_000;

describe("forecastLimitHit", () => {
  it("projects a linear pace to 100%", () => {
    const now = 1_000_000_000;
    // 40% -> 50% over 10 minutes = 1%/min; 50 points left => 50 min.
    const hit = forecastLimitHit(
      [
        { at: now - 10 * MIN, percent: 40 },
        { at: now, percent: 50 },
      ],
      now,
    );
    expect(hit).toBe(now + 50 * MIN);
  });

  it("returns null for flat, declining, or single-sample series", () => {
    const now = 1_000_000_000;
    expect(forecastLimitHit([{ at: now, percent: 50 }], now)).toBeNull();
    expect(
      forecastLimitHit(
        [
          { at: now - MIN, percent: 50 },
          { at: now, percent: 50 },
        ],
        now,
      ),
    ).toBeNull();
    expect(
      forecastLimitHit(
        [
          { at: now - MIN, percent: 50 },
          { at: now, percent: 10 }, // window rolled over
        ],
        now,
      ),
    ).toBeNull();
  });

  it("ignores samples outside the lookback window", () => {
    const now = 1_000_000_000;
    const hit = forecastLimitHit(
      [
        { at: now - 10 * 60 * MIN, percent: 1 }, // 10h ago — stale burst
        { at: now - MIN, percent: 90 },
      ],
      now,
    );
    expect(hit).toBeNull(); // only one sample inside lookback
  });

  it("returns now when already at/over 100", () => {
    const now = 1_000_000_000;
    const hit = forecastLimitHit(
      [
        { at: now - MIN, percent: 99 },
        { at: now, percent: 100 },
      ],
      now,
    );
    expect(hit).toBe(now);
  });
});

describe("detectAlerts", () => {
  it("fires each threshold once on its rising edge", () => {
    expect(detectAlerts(70, 85)).toEqual([{ kind: "threshold", level: 80, percent: 85 }]);
    expect(detectAlerts(85, 87)).toEqual([]); // already above 80, below 95 — no repeat
    expect(detectAlerts(87, 96)).toEqual([{ kind: "threshold", level: 95, percent: 96 }]);
    expect(detectAlerts(96, 97)).toEqual([]);
  });

  it("fires both levels when one jump crosses both", () => {
    expect(detectAlerts(50, 99)).toEqual([
      { kind: "threshold", level: 80, percent: 99 },
      { kind: "threshold", level: 95, percent: 99 },
    ]);
  });

  it("never alerts on the first sample (no edge yet)", () => {
    expect(detectAlerts(null, 92)).toEqual([]);
  });

  it("detects a window reset as a big drop and re-arms thresholds", () => {
    expect(detectAlerts(96, 3)).toEqual([{ kind: "reset", percent: 3 }]);
    // After the reset, climbing past 80 alerts again.
    expect(detectAlerts(3, 81)).toEqual([{ kind: "threshold", level: 80, percent: 81 }]);
  });

  it("treats falling back below the lowest threshold as a reset", () => {
    expect(detectAlerts(82, 60)).toEqual([{ kind: "reset", percent: 60 }]);
  });

  it("ignores non-finite input", () => {
    expect(detectAlerts(50, Number.NaN)).toEqual([]);
  });
});
