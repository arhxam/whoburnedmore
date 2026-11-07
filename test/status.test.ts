import { describe, expect, it } from "vitest";
import { buildStatusReport, type StatusInput } from "../src/status.js";

const NOW = 1_700_000_000_000;
const HOUR = 3600 * 1000;

function base(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    installed: true,
    loaded: true,
    drift: "ok",
    intervalMinutes: 15,
    lastSyncAt: NOW - 5 * 60 * 1000, // 5 min ago (within the 15min cadence)
    now: NOW,
    nodePath: "/opt/homebrew/bin/node",
    nodePathStable: true,
    logPath: "/home/u/.config/whoburnedmore/sync.log",
    ...overrides,
  };
}

describe("buildStatusReport (status command)", () => {
  it("reports a healthy agent as fresh, with no stale warning", () => {
    const out = buildStatusReport(base()).join("\n");
    expect(out).toContain("installed and loaded");
    expect(out).toContain("every 15m");
    expect(out).toMatch(/Fresh/);
    expect(out).not.toMatch(/STALE/);
  });

  it("warns STALE when the last sync is older than ~2x the interval", () => {
    const out = buildStatusReport(
      base({ lastSyncAt: NOW - 1 * HOUR }), // 1h ago, well past 2×15min
    ).join("\n");
    expect(out).toMatch(/STALE/);
    expect(out).not.toMatch(/✓ Fresh/);
  });

  it("warns STALE when no sync has ever been recorded", () => {
    const out = buildStatusReport(base({ lastSyncAt: null })).join("\n");
    expect(out).toMatch(/STALE/);
    expect(out).toContain("never recorded");
  });

  it("says sync was turned off on purpose after uninstall-sync, not 'run npx whoburnedmore'", () => {
    const off = buildStatusReport(base({ installed: false, loaded: false, optedOut: true })).join("\n");
    expect(off).toContain("install-sync");
    expect(off).not.toContain("run `npx whoburnedmore` to set it up");
    const missing = buildStatusReport(base({ installed: false, loaded: false })).join("\n");
    expect(missing).toContain("run `npx whoburnedmore` to set it up");
  });

  it("flags an agent that is installed but not loaded", () => {
    const out = buildStatusReport(base({ loaded: false })).join("\n");
    expect(out).toContain("NOT loaded");
  });

  it("flags a drifted config as self-repairing on next run", () => {
    const out = buildStatusReport(base({ drift: "drift" })).join("\n");
    expect(out).toMatch(/out of date/);
  });

  it("warns about a version-pinned (unstable) node path", () => {
    const out = buildStatusReport(
      base({
        nodePath: "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
        nodePathStable: false,
      }),
    ).join("\n");
    expect(out).toMatch(/version-pinned/);
  });
});
