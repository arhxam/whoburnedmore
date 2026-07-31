import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTINUE_CACHE_VERSION,
  collectContinue,
  mapContinueRecords,
  parseContinueJsonl,
} from "../src/continue.js";

const total = (e: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}) =>
  e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;

// A fixed local-noon so date bucketing is timezone-stable in CI.
const ISO = new Date(2026, 5, 10, 12, 0, 0).toISOString();
const EPOCH_MS = new Date(2026, 5, 10, 12, 0, 0).getTime();

describe("mapContinueRecords — token mapping", () => {
  it("maps a tokensGenerated event (prompt/generated + model + timestamp) with a request fingerprint", () => {
    const entries = mapContinueRecords([
      { model: "claude-sonnet-4-5", provider: "anthropic", promptTokens: 100, generatedTokens: 40, timestamp: ISO },
    ]);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.tool).toBe("continue");
    expect(e.inputTokens).toBe(100);
    expect(e.outputTokens).toBe(40);
    expect(total(e)).toBe(140);
    expect(e.requestCount).toBe(1);
    expect(e.origin).toBe("cli");
    expect(e.verified).toBe(false);
  });

  it("accepts an epoch-ms numeric timestamp as well as an ISO string", () => {
    const entries = mapContinueRecords([
      { model: "gpt-5", promptTokens: 10, generatedTokens: 5, timestamp: EPOCH_MS },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe("2026-06-10");
  });
});

describe("mapContinueRecords — grouping & filtering", () => {
  it("groups by local date and model", () => {
    const nextDayIso = new Date(2026, 5, 11, 12, 0, 0).toISOString();
    const entries = mapContinueRecords([
      { model: "claude-sonnet-4-5", promptTokens: 10, generatedTokens: 1, timestamp: ISO },
      { model: "gpt-5", promptTokens: 20, generatedTokens: 1, timestamp: ISO },
      { model: "claude-sonnet-4-5", promptTokens: 30, generatedTokens: 1, timestamp: nextDayIso },
    ]);
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.date)).size).toBe(2);
    expect(new Set(entries.map((e) => e.model)).size).toBe(2);
  });

  it("reads the real 0.2.0 record envelope and ignores sibling event types via eventName", () => {
    // Exactly the flat top-level shape Continue writes to
    // dev_data/0.2.0/tokensGenerated.jsonl (base fields + token fields).
    const real = {
      eventName: "tokensGenerated",
      schema: "0.2.0",
      timestamp: ISO,
      userId: "",
      userAgent: "vscode/1.x (Continue/1.x)",
      selectedProfileId: "local",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      promptTokens: 1234,
      generatedTokens: 567,
    };
    // A record from a sibling file (autocomplete) that happens to share fields —
    // must NOT be counted because its eventName isn't tokensGenerated.
    const sibling = { eventName: "autocomplete", timestamp: ISO, model: "gpt-5", promptTokens: 99, generatedTokens: 99 };
    const entries = mapContinueRecords([real, sibling]);
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("claude-sonnet-4-5");
    expect(total(entries[0])).toBe(1234 + 567);
    expect(entries[0].requestCount).toBe(1);
  });

  it("skips records with no model, no timestamp, or zero tokens", () => {
    const entries = mapContinueRecords([
      { promptTokens: 5, generatedTokens: 5, timestamp: ISO }, // no model
      { model: "gpt-5", promptTokens: 5, generatedTokens: 5 }, // no timestamp
      { model: "gpt-5", promptTokens: 0, generatedTokens: 0, timestamp: ISO }, // no tokens
      { model: "gpt-5", promptTokens: 5, generatedTokens: 5, timestamp: 1 }, // 1970, before coding agents
      { model: "gpt-5", promptTokens: 5, generatedTokens: 5, timestamp: Number.MAX_VALUE }, // invalid Date
      { model: "gpt-5", promptTokens: 9, generatedTokens: 1, timestamp: ISO }, // the one real event
    ]);
    expect(entries).toHaveLength(1);
    expect(total(entries[0])).toBe(10);
  });

  it("estimates cost from the model (priced → >0, unknown → 0)", () => {
    const priced = mapContinueRecords([
      { model: "claude-sonnet-4-5", promptTokens: 1_000_000, generatedTokens: 1_000_000, timestamp: ISO },
    ]);
    expect(priced[0].costUSD).toBeGreaterThan(0);
    const unknown = mapContinueRecords([
      { model: "some-unlisted-model", promptTokens: 1_000_000, generatedTokens: 1_000_000, timestamp: ISO },
    ]);
    expect(unknown[0].costUSD).toBe(0);
  });
});

describe("parseContinueJsonl", () => {
  it("parses one-object-per-line JSONL and ignores blank/garbage lines", () => {
    const body = [
      JSON.stringify({ model: "gpt-5", promptTokens: 3, generatedTokens: 2, timestamp: ISO }),
      "",
      "not json",
      JSON.stringify({ model: "gpt-5", promptTokens: 1, generatedTokens: 1, timestamp: ISO }),
    ].join("\n");
    const entries = parseContinueJsonl(body);
    expect(entries).toHaveLength(1); // same date+model → grouped
    expect(total(entries[0])).toBe(7);
    expect(entries[0].requestCount).toBe(2);
  });
});

describe("collectContinue — reads dev_data on disk", () => {
  it("invalidates caches created before the hardened file/date semantics", () => {
    expect(CONTINUE_CACHE_VERSION).toBe(2);
  });

  it("reads dev_data/**/tokensGenerated.jsonl and aggregates, or found:false when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-continue-"));
    const dataDir = join(dir, "dev_data", "0.2.0");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "tokensGenerated.jsonl"),
      JSON.stringify({ model: "claude-sonnet-4-5", promptTokens: 100, generatedTokens: 20, timestamp: ISO }) + "\n",
    );
    // A sibling legacy event file can have token-like fields but no eventName.
    // Discovery must only read the purpose-built tokensGenerated ledger.
    await writeFile(
      join(dataDir, "autocomplete.jsonl"),
      JSON.stringify({ model: "claude-sonnet-4-5", promptTokens: 999, generatedTokens: 999, timestamp: ISO }) + "\n",
    );
    const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const res = await collectContinue({
        continueDir: dir,
        env,
        cachePath: join(dir, "cache.json"),
      });
      expect(res.found).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(total(res.entries[0])).toBe(120);
      expect(res.entries[0].requestCount).toBe(1);

      const empty = await collectContinue({
        continueDir: join(dir, "nope"),
        env,
        cachePath: join(dir, "cache2.json"),
      });
      expect(empty.found).toBe(false);
      expect(empty.entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
