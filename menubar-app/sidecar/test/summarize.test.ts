import { describe, expect, it } from "vitest";

import type { DailyUsageEntry } from "../../../src/shared.js";

import { lastDays, localDay, summarize } from "../src/summarize.js";

function entry(partial: Partial<DailyUsageEntry>): DailyUsageEntry {
  return {
    date: localDay(),
    tool: "claude",
    model: "claude-fable-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    origin: "cli",
    verified: false,
    ...partial,
  } as DailyUsageEntry;
}

describe("summarize", () => {
  const now = new Date("2026-08-02T15:00:00");

  it("buckets today / week / 14d windows and zero-fills the sparkline", () => {
    const today = localDay(now);
    const entries = [
      entry({ date: today, inputTokens: 100, outputTokens: 50, costUSD: 1.5 }),
      entry({ date: lastDays(3, now)[0], cacheReadTokens: 1000, costUSD: 2 }), // 2 days ago
      entry({ date: lastDays(14, now)[0], inputTokens: 7, costUSD: 0.1 }), // 13 days ago
    ];
    const s = summarize(entries, ["claude"], false, now);
    expect(s.today.totalTokens).toBe(150);
    expect(s.today.costUSD).toBe(1.5);
    expect(s.week.totalTokens).toBe(1150); // today + 2-days-ago, not 13-days-ago
    expect(s.days).toHaveLength(14);
    expect(s.days[13].date).toBe(today);
    expect(s.days[13].tokens).toBe(150);
    expect(s.days.filter((d) => d.tokens === 0)).toHaveLength(11);
  });

  it("ranks tools and models by tokens, capping models at 5", () => {
    const today = localDay(now);
    const entries = [
      entry({ date: today, tool: "codex", model: "gpt-5", inputTokens: 900 }),
      entry({ date: today, tool: "claude", model: "claude-fable-5", inputTokens: 100 }),
      ...Array.from({ length: 7 }, (_, i) =>
        entry({ date: today, tool: "claude", model: `m${i}`, inputTokens: 10 + i }),
      ),
    ];
    const s = summarize(entries, ["claude", "codex"], false, now);
    expect(s.byToolToday[0].tool).toBe("codex");
    expect(s.byToolToday[1].tool).toBe("claude");
    expect(s.topModelsToday).toHaveLength(5);
    expect(s.topModelsToday[0].model).toBe("gpt-5");
  });

  it("handles empty entries without NaN", () => {
    const s = summarize([], [], true, now);
    expect(s.today.totalTokens).toBe(0);
    expect(s.week.costUSD).toBe(0);
    expect(s.days).toHaveLength(14);
    expect(s.partial).toBe(true);
  });

  it("lastDays is contiguous across month boundaries", () => {
    const days = lastDays(14, new Date("2026-08-05T12:00:00"));
    expect(days[0]).toBe("2026-07-23");
    expect(days[13]).toBe("2026-08-05");
    expect(new Set(days).size).toBe(14);
  });
});
