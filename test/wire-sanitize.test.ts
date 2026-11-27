import { describe, expect, it } from "vitest";
import {
  sanitizeDailyEntries,
  sanitizeSkillStats,
  sanitizeToolStats,
} from "../src/wire-sanitize.js";

describe("local-to-cloud semantic boundary", () => {
  const base = {
    date: "2026-08-10",
    tool: "claude",
    model: "claude-opus-4-8",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0.000175,
    origin: "cli" as const,
    verified: false,
  };

  it("drops one semantically impossible row without poisoning valid sources", () => {
    expect(
      sanitizeDailyEntries([
        base,
        { ...base, tool: "codex", inputTokens: Number.MAX_VALUE },
      ]),
    ).toEqual([base]);
  });

  it("pseudonymizes content-shaped provider labels deterministically", () => {
    const raw = { ...base, model: "customer secret pasted into a model field" };
    const [first] = sanitizeDailyEntries([raw]);
    const [second] = sanitizeDailyEntries([raw]);
    expect(first.model).toMatch(/^model-[a-f0-9]{12}$/);
    expect(second.model).toBe(first.model);
    expect(JSON.stringify(first)).not.toContain("customer secret");
  });

  it("keeps conventional tool and skill identifiers while hashing content-shaped names", () => {
    expect(
      sanitizeToolStats([
        { name: "mcp__github__search_code", count: 2 },
        { name: "private customer prompt text", count: 1 },
      ]).map((row) => row.name),
    ).toEqual(["mcp__github__search_code", expect.stringMatching(/^tool-[a-f0-9]{12}$/)]);
    expect(sanitizeSkillStats([{ name: "release-check", count: 1 }])).toEqual([
      { name: "release-check", count: 1 },
    ]);
  });

  it("clamps a vendor charge above the server's $/token ceiling instead of sinking the upload", () => {
    const [row] = sanitizeDailyEntries([
      { ...base, tool: "cursor", inputTokens: 300, outputTokens: 0, costUSD: 5 },
    ]);
    // 300 tokens × $200/M × 0.99 = $0.0594
    expect(row.costUSD).toBeCloseTo(0.0594, 9);
    expect(row.costUSD).toBeLessThan((300 * 200) / 1e6);
  });

  it("drops a cost-only row with no tokens (the server rejects the whole upload for it)", () => {
    expect(
      sanitizeDailyEntries([
        base,
        { ...base, model: "gpt-5.5", inputTokens: 0, outputTokens: 0, costUSD: 0.04 },
      ]),
    ).toEqual([base]);
  });

  it("keeps the 1h cache-write count, never above total cache writes", () => {
    const [row] = sanitizeDailyEntries([
      { ...base, cacheCreationTokens: 100, cacheCreation1hTokens: 250 },
    ]);
    expect(row.cacheCreation1hTokens).toBe(100);
    const [none] = sanitizeDailyEntries([{ ...base, cacheCreation1hTokens: 0 }]);
    expect(none).not.toHaveProperty("cacheCreation1hTokens");
  });
});
