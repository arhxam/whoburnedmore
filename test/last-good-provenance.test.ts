import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStat, DailyUsageEntry } from "../src/shared.js";
import {
  PROVENANCE_STORE_VERSION,
  loadProvenanceStore,
  provenanceStorePath,
  reconcileProvenance,
  saveProvenanceStore,
  type ProvenanceStore,
} from "../src/provenance-store.js";

function entry(o: {
  date: string;
  tool: string;
  model?: string;
  outputTokens?: number;
  requestCount?: number;
}): DailyUsageEntry {
  return {
    date: o.date,
    tool: o.tool,
    model: o.model ?? "claude-opus-4-8",
    inputTokens: 0,
    outputTokens: o.outputTokens ?? 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    origin: "cli",
    verified: false,
    requestCount: o.requestCount,
  };
}

function agent(over: Partial<AgentStat> = {}): AgentStat {
  return {
    messageCount: 0,
    subagentMessages: 0,
    subagentTokens: 0,
    totalTokens: 0,
    userMessageCount: 0,
    ...over,
  };
}

const KEY = "2026-07-18|claude";

describe("reconcileProvenance — no stored last-good", () => {
  it("passes entries and agent through unchanged (partial run)", () => {
    const entries = [entry({ date: "2026-07-18", tool: "claude", requestCount: 5 })];
    const r = reconcileProvenance(entries, agent(), false, null);
    expect(r.entries).toEqual(entries);
    expect(r.entries[0].requestCount).toBe(5);
    expect(r.agent).toEqual(agent());
    // First observation becomes the last-good for next time.
    expect(r.store.req[KEY]).toBe(5);
  });

  it("passes entries through unchanged (full run) and records last-good", () => {
    const entries = [entry({ date: "2026-07-18", tool: "claude", requestCount: 42 })];
    const r = reconcileProvenance(entries, agent({ messageCount: 3, totalTokens: 900 }), true, null);
    expect(r.entries).toEqual(entries);
    expect(r.store.req[KEY]).toBe(42);
    expect(r.store.agent?.totalTokens).toBe(900);
  });
});

describe("reconcileProvenance — partial run never regresses a day", () => {
  const stored: ProvenanceStore = { v: PROVENANCE_STORE_VERSION, req: { [KEY]: 100 } };

  it("restores a fingerprint that vanished (ccusage fallback: no requestCount)", () => {
    const entries = [entry({ date: "2026-07-18", tool: "claude", requestCount: undefined, outputTokens: 999 })];
    const r = reconcileProvenance(entries, agent(), false, stored);
    expect(r.entries[0].requestCount).toBe(100); // re-attached, not 0/undefined
    expect(r.store.req[KEY]).toBe(100); // best kept
  });

  it("raises a fingerprint that came back lower than the stored best", () => {
    const entries = [entry({ date: "2026-07-18", tool: "claude", requestCount: 30 })];
    const r = reconcileProvenance(entries, agent(), false, stored);
    expect(r.entries[0].requestCount).toBe(100); // 30 + deficit 70
    expect(r.store.req[KEY]).toBe(100);
  });

  it("leaves a fingerprint alone when it already meets/exceeds the stored best", () => {
    const entries = [entry({ date: "2026-07-18", tool: "claude", requestCount: 130 })];
    const r = reconcileProvenance(entries, agent(), false, stored);
    expect(r.entries[0].requestCount).toBe(130);
    expect(r.store.req[KEY]).toBe(130); // best advances upward
  });

  it("attaches the deficit to the heaviest row of a multi-model day", () => {
    const light = entry({ date: "2026-07-18", tool: "claude", model: "haiku", requestCount: 10, outputTokens: 10 });
    const heavy = entry({ date: "2026-07-18", tool: "claude", model: "opus", requestCount: 20, outputTokens: 5000 });
    const r = reconcileProvenance([light, heavy], agent(), false, stored);
    const total = r.entries.reduce((s, e) => s + (e.requestCount ?? 0), 0);
    expect(total).toBe(100); // day total restored (30 current -> 100)
    // The heavy row carried the 70-request deficit; the light row is untouched.
    expect(r.entries.find((e) => e.model === "haiku")!.requestCount).toBe(10);
    expect(r.entries.find((e) => e.model === "opus")!.requestCount).toBe(90);
  });

  it("never fabricates a row for a stored day that produced nothing this run", () => {
    const store: ProvenanceStore = { v: PROVENANCE_STORE_VERSION, req: { "2026-07-01|claude": 50 } };
    const entries = [entry({ date: "2026-07-18", tool: "claude", requestCount: 3 })];
    const r = reconcileProvenance(entries, agent(), false, store);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].date).toBe("2026-07-18");
    expect(r.store.req["2026-07-01|claude"]).toBe(50); // stored memory preserved
  });
});

describe("reconcileProvenance — full run is authoritative", () => {
  it("allows a legitimate decrease and refreshes the store downward", () => {
    const stored: ProvenanceStore = { v: PROVENANCE_STORE_VERSION, req: { [KEY]: 100 } };
    const entries = [entry({ date: "2026-07-18", tool: "claude", requestCount: 40 })];
    const r = reconcileProvenance(entries, agent({ messageCount: 1, totalTokens: 500 }), true, stored);
    expect(r.entries[0].requestCount).toBe(40); // NOT restored on a full run
    expect(r.store.req[KEY]).toBe(40); // authoritative refresh
    expect(r.store.agent?.totalTokens).toBe(500);
  });
});

describe("reconcileProvenance — agent rollup", () => {
  it("re-attaches the richer stored agent rollup on a partial run", () => {
    const store: ProvenanceStore = {
      v: PROVENANCE_STORE_VERSION,
      req: {},
      agent: agent({ messageCount: 3, totalTokens: 1000 }),
    };
    const partial = agent({ messageCount: 1, totalTokens: 200 });
    const r = reconcileProvenance([entry({ date: "2026-07-18", tool: "claude", requestCount: 1 })], partial, false, store);
    expect(r.agent.totalTokens).toBe(1000); // stored is richer → re-attached
    expect(r.store.agent?.totalTokens).toBe(1000); // partial did not overwrite it
  });
});

describe("provenance store — disk round-trip", () => {
  it("saves and loads, honoring WHOBURNEDMORE_CONFIG_DIR, and ignores corrupt files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-prov-"));
    try {
      const path = provenanceStorePath({ WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
      expect(path.startsWith(dir)).toBe(true);
      const store: ProvenanceStore = {
        v: PROVENANCE_STORE_VERSION,
        req: { [KEY]: 7 },
        agent: agent({ totalTokens: 9 }),
      };
      saveProvenanceStore(path, store);
      expect(loadProvenanceStore(path)).toEqual(store);
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      }

      await writeFile(path, "{ not valid json");
      expect(loadProvenanceStore(path)).toBeNull();

      // A version mismatch is treated as absent (rebuilt on next full run).
      await writeFile(path, JSON.stringify({ v: PROVENANCE_STORE_VERSION + 99, req: { [KEY]: 5 } }));
      expect(loadProvenanceStore(path)).toBeNull();

      await writeFile(path, "x".repeat(4 * 1024 * 1024 + 1));
      expect(loadProvenanceStore(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
