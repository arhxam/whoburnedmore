import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorCookie, fetchCursorEvents, mapCursorEvents } from "../src/cursor.js";

// Shape captured from POST cursor.com/api/dashboard/get-filtered-usage-events.
describe("mapCursorEvents", () => {
  const events = [
    {
      timestamp: "1781012410601",
      model: "claude-opus-4-8-thinking-high",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 60,
        cacheWriteTokens: 150,
        cacheReadTokens: 5000,
        totalCents: 486.07,
      },
    },
    // No tokenUsage (errored/included event) → skipped.
    { timestamp: "1781012319855", model: "claude-opus-4-8-thinking-high" },
    // Same day + model → merges into the first entry.
    {
      timestamp: "1781012410000",
      model: "claude-opus-4-8-thinking-high",
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 13.93 },
    },
  ];

  it("folds events into cursor daily entries (merged by date+model) with USD cost", () => {
    const { entries, blocks } = mapCursorEvents(events);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.tool).toBe("cursor");
    expect(e.model).toBe("claude-opus-4-8-thinking-high");
    expect(e.inputTokens).toBe(110);
    expect(e.outputTokens).toBe(65);
    expect(e.cacheReadTokens).toBe(5000);
    expect(e.costUSD).toBeCloseTo(5.0, 2); // (486.07 + 13.93) / 100
    expect(e.origin).toBe("cli");
    expect(e.verified).toBe(false);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0].totalTokens).toBeGreaterThan(0);
  });

  it("estimates API-equivalent cost when Cursor reports totalCents=0 (included usage)", () => {
    const { entries } = mapCursorEvents([
      {
        timestamp: "1781012410601",
        model: "claude-opus-4-8-thinking-high",
        tokenUsage: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalCents: 0,
        },
      },
    ]);
    expect(entries).toHaveLength(1);
    // opus fallback: $5/M in + $25/M out → $5 + $2.5 = $7.5
    expect(entries[0].costUSD).toBeCloseTo(7.5, 2);
  });

  it("keeps billed Cursor cents when present instead of overwriting with estimate", () => {
    const { entries } = mapCursorEvents([
      {
        timestamp: "1781012410601",
        model: "claude-opus-4-8-thinking-high",
        tokenUsage: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          totalCents: 12.34,
        },
      },
    ]);
    expect(entries[0].costUSD).toBeCloseTo(0.1234, 4);
  });

  it("skips events without tokenUsage or timestamp", () => {
    expect(mapCursorEvents([{ model: "x" }]).entries).toEqual([]);
    expect(mapCursorEvents([{ tokenUsage: { inputTokens: 5 } }]).entries).toEqual([]);
  });

  it("skips impossible timestamps instead of throwing or poisoning the payload", () => {
    const bad = [
      { timestamp: "1", model: "x", tokenUsage: { inputTokens: 5 } },
      {
        timestamp: String(Number.MAX_VALUE),
        model: "x",
        tokenUsage: { inputTokens: 5 },
      },
    ];
    expect(() => mapCursorEvents(bad)).not.toThrow();
    expect(mapCursorEvents(bad)).toEqual({ entries: [], blocks: [] });
  });
});

describe("cursorCookie", () => {
  it("builds the WorkosCursorSessionToken cookie from the JWT sub", () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: "google-oauth2|user_01" }),
    ).toString("base64url");
    const token = `h.${payload}.sig`;
    expect(cursorCookie(token)).toBe(
      `WorkosCursorSessionToken=google-oauth2|user_01%3A%3A${token}`,
    );
  });

  it("returns null for a non-JWT token", () => {
    expect(cursorCookie("notajwt")).toBeNull();
  });
});

describe("fetchCursorEvents pagination", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okPage = (events: unknown[]) => ({
    ok: true,
    json: async () => ({ usageEventsDisplay: events }),
  });

  it("stops cleanly on a short (final) page and returns all events", async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({ timestamp: String(i) }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okPage(full)) // full page → keep going
      .mockResolvedValueOnce(okPage([{ timestamp: "x" }])); // short page → stop
    vi.stubGlobal("fetch", fetchMock);
    const events = await fetchCursorEvents("cookie", 30, 2);
    expect(events).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a mid-pagination HTTP error rather than returning partial data", async () => {
    // First page succeeds (full), second page 500s. Returning the first page's
    // events would let a partial snapshot overwrite recent-day Cursor totals, so
    // we must abort instead.
    const full = Array.from({ length: 2 }, (_, i) => ({ timestamp: String(i) }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okPage(full))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCursorEvents("cookie", 30, 2)).rejects.toThrow(/HTTP 500/);
  });
});
