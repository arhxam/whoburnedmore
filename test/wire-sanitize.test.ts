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
    costUSD: 0.1,
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
});
