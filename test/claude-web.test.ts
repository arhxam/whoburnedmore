import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectClaudeWeb, findClaudeWebExport, mapClaudeWebExport } from "../src/claude-web.js";

const NOW = Date.parse("2026-06-15T12:00:00Z");
const doc = (days: unknown[]) => ({ format: "whoburnedmore.claude-web", version: 1, estimated: true, days });
const row = { date: "2026-06-10", model: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 50, cacheCreationTokens: 200, cacheReadTokens: 1000, replies: 3 };

describe("mapClaudeWebExport", () => {
  it("maps rows to claude-web entries and merges duplicate (date, model)", () => {
    const e = mapClaudeWebExport(doc([row, row]), NOW);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ tool: "claude-web", model: "claude-sonnet-4-5", outputTokens: 100, cacheReadTokens: 2000, requestCount: 6, verified: false });
    expect(e[0].costUSD).toBeGreaterThan(0);
  });

  it("rejects wrong format, bad dates, future dates, non-claude models and empty rows", () => {
    expect(mapClaudeWebExport({ ...doc([row]), format: "x" }, NOW)).toEqual([]);
    expect(mapClaudeWebExport(doc([
      { ...row, date: "2026-13-xx" },
      { ...row, date: "2027-01-01" },
      { ...row, model: "gpt-5" },
      { ...row, model: "claude-<script>" },
      { ...row, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: -5 },
    ]), NOW)).toEqual([]);
  });
});

describe("collectClaudeWeb", () => {
  it("reads the newest export in Downloads", async () => {
    const home = await mkdtemp(join(tmpdir(), "wbm-cw-"));
    const dl = join(home, "Downloads");
    await mkdir(dl);
    const old = join(dl, "whoburnedmore-claude-web.json");
    const fresh = join(dl, "whoburnedmore-claude-web (1).json");
    await writeFile(old, JSON.stringify(doc([{ ...row, outputTokens: 1 }])));
    await writeFile(fresh, JSON.stringify(doc([row])));
    await utimes(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const env = { HOME: home, USERPROFILE: home };
    expect(findClaudeWebExport(env)).toBe(fresh);
    const r = await collectClaudeWeb({ env, now: NOW });
    expect(r.found).toBe(true);
    expect(r.entries[0].outputTokens).toBe(50);
    expect((await collectClaudeWeb({ env: { ...env, WHOBURNEDMORE_CLAUDE_WEB: "0" } })).found).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  it("is a no-op when there's no export", async () => {
    const home = await mkdtemp(join(tmpdir(), "wbm-cw-"));
    expect((await collectClaudeWeb({ env: { HOME: home, USERPROFILE: home } })).found).toBe(false);
    await rm(home, { recursive: true, force: true });
  });
});
