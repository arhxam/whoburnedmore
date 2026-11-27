import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateDevinSession,
  collectDevinNative,
  devinCliRoots,
  isDevinRoutingMode,
  parseDevinLogRecord,
  parseDevinSessionLog,
} from "../src/native/devin.js";
import { selectDevinEntries } from "../src/collect.js";
import type { DailyUsageEntry } from "../src/shared.js";

// Noon UTC keeps the local day stable in any test-runner timezone.
const T = Date.UTC(2026, 10, 20, 12, 0, 0);
const NOW = Date.UTC(2026, 10, 24);
const DAY = new Date(T).toLocaleDateString("en-CA");

function node(
  id: number,
  metadata: Record<string, unknown> | null,
  opts: { role?: string; at?: unknown } = {},
): string {
  return JSON.stringify({
    kind: "node",
    at: opts.at ?? T / 1000,
    node: {
      id,
      parent_id: id - 1,
      metadata: {},
      message: { role: opts.role ?? "assistant", ...(metadata ? { metadata } : {}) },
    },
  });
}

function usage(requestId: string | null, m: Partial<Record<string, number>>, model = "claude-sonnet-4-5") {
  return {
    ...(requestId ? { request_id: requestId } : {}),
    generation_model: model,
    created_at: new Date(T).toISOString(),
    metrics: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      ...m,
    },
  };
}

describe("parseDevinLogRecord", () => {
  it("reads an assistant node's exact metrics", () => {
    const r = parseDevinLogRecord(
      node(12, usage("req-1", { input_tokens: 355, output_tokens: 229, cache_read_tokens: 13933, cache_creation_tokens: 11563 })),
      NOW,
    );
    expect(r).toEqual({
      nodeId: "12",
      request: {
        key: "request:req-1",
        date: DAY,
        model: "claude-sonnet-4-5",
        inputTokens: 355,
        outputTokens: 229,
        cacheCreationTokens: 11563,
        cacheReadTokens: 13933,
      },
    });
  });

  it("ignores non-node records and garbage; marks usage-less nodes as null", () => {
    expect(parseDevinLogRecord(JSON.stringify({ kind: "tool_call_state", x: 1 }), NOW)).toBeUndefined();
    expect(parseDevinLogRecord("{not json", NOW)).toBeUndefined();
    expect(parseDevinLogRecord("", NOW)).toBeUndefined();
    expect(parseDevinLogRecord(node(1, null, { role: "user" }), NOW)).toEqual({ nodeId: "1", request: null });
    expect(parseDevinLogRecord(node(2, usage("r", {})), NOW)).toEqual({ nodeId: "2", request: null });
  });

  it("falls back to num_tokens as output when there is no metrics block", () => {
    const r = parseDevinLogRecord(node(3, { request_id: "r3", num_tokens: 147, generation_model: "gpt-5" }), NOW);
    expect(r?.request).toMatchObject({ outputTokens: 147, inputTokens: 0 });
  });

  it("never reports a routing mode or Fusion profile as the model", () => {
    expect(isDevinRoutingMode("adaptive")).toBe(true);
    expect(isDevinRoutingMode("fusion-claude-opus-5-5-medium-sidekick-swe-2-medium")).toBe(true);
    expect(isDevinRoutingMode("claude-opus-5-5-medium")).toBe(false);
    const r = parseDevinLogRecord(node(4, usage("r4", { output_tokens: 5 }, "adaptive")), NOW);
    expect(r?.request?.model).toBe("devin");
  });

  it("uses created_at over the append time, and accepts `at` in seconds or ms", () => {
    const later = T + 3 * 86_400_000;
    const r = parseDevinLogRecord(node(5, usage("r5", { output_tokens: 1 }), { at: later / 1000 }), NOW);
    expect(r?.request?.date).toBe(DAY);
    const noCreated = { request_id: "r6", generation_model: "m", metrics: { output_tokens: 1 } };
    expect(parseDevinLogRecord(node(6, noCreated, { at: T }), NOW)?.request?.date).toBe(DAY);
    expect(parseDevinLogRecord(node(7, noCreated, { at: T / 1000 }), NOW)?.request?.date).toBe(DAY);
  });

  it("drops implausible dates instead of producing an invalid row", () => {
    const future = { request_id: "r8", generation_model: "m", created_at: "2099-01-01T00:00:00Z", metrics: { output_tokens: 1 } };
    expect(parseDevinLogRecord(node(8, future), NOW)?.request).toBeNull();
  });
});

describe("aggregateDevinSession", () => {
  it("keeps only the LAST record per node id (append-only updates)", () => {
    const rows = parseDevinSessionLog(
      [
        node(1, usage("req-a", { output_tokens: 10 })),
        node(1, usage("req-a", { output_tokens: 40, input_tokens: 2 })),
      ].join("\n"),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slice(2, 6)).toEqual([2, 40, 0, 0]);
    expect(rows[0]![7]).toBe(1);
  });

  it("a later usage-less version of a node removes its earlier usage", () => {
    const rows = parseDevinSessionLog(
      [node(1, usage("req-a", { output_tokens: 10 })), node(1, null, { role: "user" })].join("\n"),
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("counts each request_id once even across distinct node ids", () => {
    const rows = parseDevinSessionLog(
      [
        node(1, usage("req-a", { input_tokens: 100, output_tokens: 10 })),
        node(2, usage("req-a", { input_tokens: 100, output_tokens: 10 })),
        node(3, usage("req-b", { input_tokens: 1, output_tokens: 1 })),
        node(4, usage(null, { output_tokens: 7 })),
        node(5, usage(null, { output_tokens: 7 })),
      ].join("\n"),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slice(2, 4)).toEqual([101, 25]);
    expect(rows[0]![7]).toBe(4); // req-a, req-b, node:4, node:5
  });

  it("splits by model and prices known models", () => {
    const rows = aggregateDevinSession([
      parseDevinLogRecord(node(1, usage("a", { input_tokens: 1_000_000 }, "claude-sonnet-4-5")), NOW)!,
      parseDevinLogRecord(node(2, usage("b", { input_tokens: 1_000_000 }, "unknown-model-zz")), NOW)!,
    ]);
    const byModel = Object.fromEntries(rows.map((r) => [r[1], r]));
    expect(byModel["claude-sonnet-4-5"]![6]).toBeGreaterThan(0);
    expect(byModel["unknown-model-zz"]![6]).toBe(0);
  });
});

describe("devinCliRoots", () => {
  it("honors XDG_DATA_HOME and defaults to ~/.local/share/devin/cli", () => {
    expect(devinCliRoots({ HOME: "/h" })).toContain(join("/h", ".local", "share", "devin", "cli"));
    expect(devinCliRoots({ HOME: "/h", XDG_DATA_HOME: "/x" })).toContain(join("/x", "devin", "cli"));
  });

  it("uses only DEVIN_SESSIONS_DIR/cli when the override is set", () => {
    expect(devinCliRoots({ HOME: "/h", XDG_DATA_HOME: "/x", DEVIN_SESSIONS_DIR: "/net/devin" })).toEqual([
      join("/net/devin", "cli"),
    ]);
    expect(devinCliRoots({ HOME: "/h", DEVIN_SESSIONS_DIR: "  " })).toContain(
      join("/h", ".local", "share", "devin", "cli"),
    );
  });
});

describe("collectDevinNative", () => {
  function fixture(): { root: string; cache: string; sessions: string } {
    const dir = mkdtempSync(join(tmpdir(), "wbm-devin-"));
    const root = join(dir, "cli");
    const sessions = join(root, "sessions");
    mkdirSync(sessions, { recursive: true });
    return { root, cache: join(dir, "cache.json"), sessions };
  }

  it("is a clean no-op when Devin isn't installed", async () => {
    const res = await collectDevinNative({ roots: [join(tmpdir(), "no-such-devin-root")] });
    expect(res).toEqual({ entries: [], found: false, filesScanned: 0 });
  });

  it("merges sessions into per-day × model entries with a request fingerprint", async () => {
    const { root, cache, sessions } = fixture();
    for (const [id, lines] of Object.entries({
      s1: [node(1, usage("r1", { input_tokens: 10, output_tokens: 5 })), node(2, usage("r2", { input_tokens: 1 }))],
      s2: [node(1, usage("r1", { input_tokens: 3 }))], // same request id, different session: counts
    })) {
      mkdirSync(join(sessions, id));
      writeFileSync(join(sessions, id, "meta.json"), JSON.stringify({ id, model: "adaptive" }));
      writeFileSync(join(sessions, id, "log.jsonl"), lines.join("\n") + "\n");
    }
    // A session directory whose log isn't written yet must not break the scan.
    mkdirSync(join(sessions, "s3-starting"));

    const res = await collectDevinNative({ roots: [root], cachePath: cache, now: () => NOW });
    expect(res.found).toBe(true);
    expect(res.timedOut).toBeUndefined();
    expect(res.entries).toEqual([
      expect.objectContaining({
        date: DAY,
        tool: "devin",
        model: "claude-sonnet-4-5",
        inputTokens: 14,
        outputTokens: 5,
        requestCount: 3,
        origin: "cli",
        verified: false,
      }),
    ]);

    // Warm run reads nothing and returns the same totals.
    const warm = await collectDevinNative({ roots: [root], cachePath: cache, now: () => NOW });
    expect(warm.filesScanned).toBe(0);
    expect(warm.entries).toEqual(res.entries);
  });

  it("bows out on budget exhaustion instead of submitting a partial corpus", async () => {
    const { root, cache, sessions } = fixture();
    mkdirSync(join(sessions, "s1"));
    writeFileSync(join(sessions, "s1", "log.jsonl"), node(1, usage("r", { output_tokens: 1 })));
    let t = NOW;
    const res = await collectDevinNative({
      roots: [root],
      cachePath: cache,
      budgetMs: 0,
      now: () => (t += 1000),
    });
    expect(res).toMatchObject({ entries: [], found: true, timedOut: true });
  });

  it("skips an unreadable session log without losing the others", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { root, cache, sessions } = fixture();
    for (const id of ["ok", "locked"]) {
      mkdirSync(join(sessions, id));
      writeFileSync(join(sessions, id, "log.jsonl"), node(1, usage(`r-${id}`, { output_tokens: 2 })));
    }
    chmodSync(join(sessions, "locked", "log.jsonl"), 0o000);
    const res = await collectDevinNative({ roots: [root], cachePath: cache, now: () => NOW });
    expect(res.entries[0]).toMatchObject({ outputTokens: 2, requestCount: 1 });
    expect(res.permissionDenied).toHaveLength(1);
  });
});

describe("selectDevinEntries", () => {
  const row = (tool: string, outputTokens: number): DailyUsageEntry => ({
    date: "2026-11-20",
    tool,
    model: "m",
    inputTokens: 0,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    origin: "cli",
    verified: false,
  });
  const tokscale = [row("devin", 5), row("zed", 7)];

  it("uses the native session logs and drops tokscale's legacy Devin rows", () => {
    const out = selectDevinEntries({ found: true, entries: [row("devin", 9)] }, tokscale);
    expect(out.native.map((e) => e.outputTokens)).toEqual([9]);
    expect(out.tokscale.map((e) => e.tool)).toEqual(["zed"]);
  });

  it("sends no Devin rows at all when the native read timed out or threw", () => {
    for (const native of [
      { found: true, timedOut: true, entries: [] },
      { found: false, timedOut: true, entries: [] },
    ]) {
      const out = selectDevinEntries(native, tokscale);
      expect(out.native).toEqual([]);
      expect(out.tokscale.map((e) => e.tool)).toEqual(["zed"]);
    }
  });

  it("falls back to tokscale's legacy store only when there are no session logs", () => {
    const out = selectDevinEntries({ found: false, entries: [] }, tokscale);
    expect(out.native).toEqual([]);
    expect(out.tokscale.map((e) => e.tool)).toEqual(["devin", "zed"]);
  });
});
