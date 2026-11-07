import { afterEach, describe, expect, it } from "vitest";
import { renderDashboardHtml } from "../src/local-dashboard.js";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

const entry = (date: string) => ({
  date,
  tool: "claude",
  model: "claude-sonnet-4-5",
  inputTokens: 5_000_000,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUSD: 15,
  origin: "cli" as const,
  verified: false,
});

const todayRail = (html: string) => /today<\/span><span class="rval[^"]*">([^<]*)</.exec(html)?.[1];

describe("local dashboard dates", () => {
  it("counts the user's local day as today, west of UTC", () => {
    process.env.TZ = "America/Los_Angeles";
    // 6pm on Nov 6 in Los Angeles is already Nov 7 in UTC.
    const html = renderDashboardHtml([entry("2026-11-06")], new Date("2026-11-07T02:00:00Z"));
    expect(todayRail(html)).toBe("5.0M");
  });

  it("counts the user's local day as today, east of UTC", () => {
    process.env.TZ = "Asia/Kolkata";
    // 1am on Nov 8 in India is still Nov 7 in UTC.
    const html = renderDashboardHtml([entry("2026-11-08")], new Date("2026-11-07T19:30:00Z"));
    expect(todayRail(html)).toBe("5.0M");
  });

  it("puts today's bar last in the 60-day chart", () => {
    process.env.TZ = "America/Los_Angeles";
    const html = renderDashboardHtml([entry("2026-11-06")], new Date("2026-11-07T02:00:00Z"));
    expect(html).toContain("2026-11-06");
    expect(html).not.toContain("2026-11-07");
    expect(html).toContain("generated 2026-11-06 18:00");
  });
});
