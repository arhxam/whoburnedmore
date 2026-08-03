import { describe, expect, it } from "vitest";

import { mapCursorUsageResponse } from "../src/cursor-limits.js";

const POPULATED = {
  startOfMonth: "2026-08-01T00:00:00.000Z",
  "gpt-4": { numRequests: 320, numRequestsTotal: 320, maxRequestUsage: 500, numTokens: 12345 },
  "gpt-3.5-turbo": { numRequests: 10, numRequestsTotal: 10, maxRequestUsage: 100, numTokens: 100 },
};

describe("cursor-limits mapping", () => {
  it("cursor-limits: maps a populated /api/usage response", () => {
    const l = mapCursorUsageResponse(POPULATED);
    expect(l.present).toBe(true);
    expect(l.used).toBe(330); // 320 + 10
    expect(l.limit).toBe(600); // 500 + 100
    expect(l.planPercent).toBe(55); // 330/600 * 100
    expect(l.renewsAt).toBe("2026-09-01T00:00:00.000Z"); // startOfMonth + 1 month
  });

  it("cursor-limits: no maxRequestUsage anywhere still reports usage without a percent", () => {
    const l = mapCursorUsageResponse({
      startOfMonth: "2026-08-01T00:00:00.000Z",
      "gpt-4": { numRequests: 42, maxRequestUsage: null },
    });
    expect(l.present).toBe(true);
    expect(l.used).toBe(42);
    expect(l.limit).toBeNull();
    expect(l.planPercent).toBeNull();
  });

  it("cursor-limits: malformed/missing shapes are present:false, never throw", () => {
    expect(mapCursorUsageResponse(null).present).toBe(false);
    expect(mapCursorUsageResponse(undefined).present).toBe(false);
    expect(mapCursorUsageResponse("not an object").present).toBe(false);
    expect(mapCursorUsageResponse([1, 2, 3]).present).toBe(false);
    expect(mapCursorUsageResponse({}).present).toBe(false);
    expect(mapCursorUsageResponse({ startOfMonth: "2026-08-01" }).present).toBe(false);
    expect(mapCursorUsageResponse({ error: "unauthorized" }).present).toBe(false);
  });

  it("cursor-limits: bad startOfMonth doesn't crash, just yields no renewsAt", () => {
    const l = mapCursorUsageResponse({
      startOfMonth: "not-a-date",
      "gpt-4": { numRequests: 5 },
    });
    expect(l.present).toBe(true);
    expect(l.renewsAt).toBeNull();
  });
});
