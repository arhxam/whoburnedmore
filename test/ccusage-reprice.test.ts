import { afterEach, describe, expect, it } from "vitest";
import { estimateCostUSD, setLivePricing } from "../src/shared.js";
import {
  mapCcusageDaily,
  mapCcusageSessions,
  repriceCcusageCost,
} from "../src/collect.js";

// A model newer than ccusage's bundled snapshot: ccusage `--offline` prices it $0.
const NEW_CODEX_MODEL = "gpt-6-astra";
const LIVE = { [NEW_CODEX_MODEL]: [10, 50, 12.5, 1] as [number, number, number, number] };

afterEach(() => setLivePricing(null));

const astraDay = {
  date: "2026-11-03",
  totalCost: 0,
  models: {
    [NEW_CODEX_MODEL]: {
      inputTokens: 5_745_555,
      outputTokens: 948_674,
      cacheCreationTokens: 0,
      cacheReadTokens: 350_165_504,
    },
  },
};

describe("ccusage cost re-pricing", () => {
  it("prices a Codex day that ccusage reported as $0 with the live table", () => {
    setLivePricing(LIVE);
    const [entry] = mapCcusageDaily("codex", { daily: [astraDay] }, Date.parse("2026-11-07"));
    // 5.745555*10 + 0.948674*50 + 350.165504*1 = 455.06
    expect(entry.costUSD).toBeCloseTo(455.06, 1);
  });

  it("keeps a positive cost recorded by a non-Codex tool", () => {
    setLivePricing(LIVE);
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    expect(repriceCcusageCost("opencode", NEW_CODEX_MODEL, tokens, 0.42)).toBe(0.42);
  });

  it("fills a $0 Claude cost but keeps a $0 recorded by a billing-record source", () => {
    setLivePricing(LIVE);
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    expect(repriceCcusageCost("claude", NEW_CODEX_MODEL, tokens, 0)).toBeCloseTo(10, 6);
    // OpenCode records the provider's actual charge: $0 can be a free model.
    expect(repriceCcusageCost("opencode", NEW_CODEX_MODEL, tokens, 0)).toBe(0);
  });

  it("keeps ccusage's positive Codex cost when only a family guess is available", () => {
    // No live table: an unreleased gpt id only reaches a family fallback tier.
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    expect(repriceCcusageCost("codex", "gpt-9-unreleased", tokens, 7)).toBe(7);
  });

  it("leaves models nothing can price at $0", () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    expect(repriceCcusageCost("codex", "unknown", tokens, 0)).toBe(0);
    expect(repriceCcusageCost("cursor", "default", tokens, 0)).toBe(0);
  });

  it("re-prices a single-model Codex session but keeps mixed-model session totals", () => {
    setLivePricing(LIVE);
    const base = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, agent: "codex", totalCost: 0 };
    const [single, mixed] = mapCcusageSessions({
      session: [
        { ...base, sessionId: "s1", modelsUsed: [NEW_CODEX_MODEL] },
        { ...base, sessionId: "s2", modelsUsed: [NEW_CODEX_MODEL, "gpt-5.5"], totalCost: 3 },
      ],
    });
    expect(single.costUSD).toBeCloseTo(
      estimateCostUSD(NEW_CODEX_MODEL, { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }),
      6,
    );
    expect(mixed.costUSD).toBe(3);
  });
});
