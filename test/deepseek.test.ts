import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import {
  DEEPSEEK_ZSTD_AVAILABLE,
  collectDeepseek,
  mapDeepseekRequests,
  parseDeepseekSession,
  type DeepseekRequest,
} from "../src/deepseek.js";

// A fixed local-noon so date bucketing is timezone-stable in CI.
const NOON = new Date(2026, 9, 2, 12, 0, 0).getTime();
const NEXT_NOON = new Date(2026, 9, 3, 12, 0, 0).getTime();

const zstd = (text: string): Buffer =>
  (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync(
    Buffer.from(text, "utf8"),
  );

function assistant(
  id: string,
  usage: Record<string, number>,
  over: { time?: number; model?: string | null; seq?: number } = {},
): string {
  return JSON.stringify({
    type: "assistant/message",
    seq: over.seq ?? 1,
    time: over.time ?? NOON,
    data: {
      message: {
        role: "assistant",
        id,
        source: {
          kind: "model",
          provider: "deepseek-account",
          model: over.model === undefined ? "deepseek-flash" : over.model,
        },
      },
      usage,
    },
  });
}

const USAGE = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 7, totalTokens: 1047 };

describe("mapDeepseekRequests", () => {
  it("maps the four token buckets and counts one request each", () => {
    const entries = mapDeepseekRequests([["a", "2026-10-02", "deepseek-flash", 100, 40, 7, 900]]);
    expect(entries).toEqual([
      expect.objectContaining({
        date: "2026-10-02",
        tool: "deepseek",
        model: "deepseek-flash",
        inputTokens: 100,
        outputTokens: 40,
        cacheCreationTokens: 7,
        cacheReadTokens: 900,
        origin: "cli",
        verified: false,
        requestCount: 1,
      }),
    ]);
  });

  it("groups by date and model", () => {
    const requests: DeepseekRequest[] = [
      ["a", "2026-10-02", "deepseek-flash", 10, 1, 0, 0],
      ["b", "2026-10-02", "deepseek-flash", 20, 2, 0, 0],
      ["c", "2026-10-02", "deepseek-pro", 30, 3, 0, 0],
      ["d", "2026-10-03", "deepseek-flash", 40, 4, 0, 0],
    ];
    const entries = mapDeepseekRequests(requests);
    expect(entries).toHaveLength(3);
    const first = entries.find((e) => e.date === "2026-10-02" && e.model === "deepseek-flash");
    expect(first).toMatchObject({ inputTokens: 30, outputTokens: 3, requestCount: 2 });
  });

  it("counts a repeated message id once, keeping the larger occurrence", () => {
    const entries = mapDeepseekRequests([
      ["a", "2026-10-02", "deepseek-flash", 10, 1, 0, 0],
      ["a", "2026-10-02", "deepseek-flash", 50, 5, 0, 0],
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ inputTokens: 50, outputTokens: 5, requestCount: 1 });
  });
});

describe.skipIf(!DEEPSEEK_ZSTD_AVAILABLE)("parseDeepseekSession", () => {
  it("reads usage from assistant messages and ignores every other event", () => {
    const log = [
      JSON.stringify({ type: "session", version: 4, id: "s" }),
      JSON.stringify({ type: "user/message", seq: 1, time: NOON, data: { role: "user" } }),
      assistant("m1", USAGE),
      assistant("m9", USAGE).replace('"type":"assistant/message"', '"type":"replay","of":"assistant/message"'),
      assistant("m2", { inputTokens: 5, outputTokens: 6 }, { time: NEXT_NOON }),
      "",
    ].join("\n");
    expect(parseDeepseekSession(zstd(log), "f")).toEqual([
      ["m1", "2026-10-02", "deepseek-flash", 100, 40, 7, 900],
      ["m2", "2026-10-03", "deepseek-flash", 5, 6, 0, 0],
    ]);
  });

  it("joins lines split across frames", () => {
    const text = [assistant("m1", USAGE), assistant("m2", USAGE), assistant("m3", USAGE), ""].join("\n");
    const a = Math.floor(text.length / 6);
    const b = Math.floor(text.length / 2);
    const bytes = Buffer.concat([zstd(text.slice(0, a)), zstd(text.slice(a, b)), zstd(text.slice(b))]);
    expect(parseDeepseekSession(bytes, "f").map((r) => r[0])).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps the frames before a truncated one", () => {
    const good = zstd(assistant("m1", USAGE) + "\n");
    const broken = zstd(assistant("m2", USAGE) + "\n");
    const bytes = Buffer.concat([good, broken.subarray(0, broken.length - 5)]);
    expect(parseDeepseekSession(bytes, "f").map((r) => r[0])).toEqual(["m1"]);
  });

  it("skips records with no model, no usable time, or no tokens", () => {
    const log = [
      assistant("m1", USAGE, { model: null }),
      assistant("m2", USAGE, { time: 5 }),
      assistant("m3", { inputTokens: 0, outputTokens: 0 }),
      "not json assistant/message",
      "",
    ].join("\n");
    expect(parseDeepseekSession(zstd(log), "f")).toEqual([]);
  });

  it("scopes the id of a message without one to its file and seq", () => {
    const line = assistant("", USAGE, { seq: 42 }) + "\n";
    expect(parseDeepseekSession(zstd(line), "path/a")[0][0]).toBe("path/a#42");
  });

  it("returns nothing for bytes that are not zstd", () => {
    expect(parseDeepseekSession(Buffer.from("plain text\n"), "f")).toEqual([]);
  });
});

describe.skipIf(!DEEPSEEK_ZSTD_AVAILABLE)("collectDeepseek", () => {
  async function withHome(run: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "wbm-dsh-"));
    try {
      await run(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  async function writeSession(home: string, name: string, lines: string[]): Promise<void> {
    const dir = join(home, "sessions", "--workspace--", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.v4.jsonl.zstd"), zstd(lines.join("\n") + "\n"));
  }

  it("reports found:false when the harness has no sessions", async () => {
    await withHome(async (home) => {
      const res = await collectDeepseek({ dshDir: home, cachePath: join(home, "cache.json") });
      expect(res).toEqual({ entries: [], found: false, filesScanned: 0 });
    });
  });

  it("aggregates sessions, dedups across files, and reuses the cache", async () => {
    await withHome(async (home) => {
      await writeSession(home, "session-1", [assistant("m1", USAGE), assistant("m2", USAGE)]);
      await writeSession(home, "session-2", [assistant("m2", USAGE), assistant("m3", USAGE)]);
      await writeFile(join(home, "sessions", "--workspace--", "session-1", "notes.txt"), "x");
      const opts = { dshDir: home, cachePath: join(home, "cache.json") };

      const first = await collectDeepseek(opts);
      expect(first.found).toBe(true);
      expect(first.filesScanned).toBe(2);
      expect(first.entries).toHaveLength(1);
      expect(first.entries[0]).toMatchObject({
        tool: "deepseek",
        inputTokens: 300,
        outputTokens: 120,
        cacheCreationTokens: 21,
        cacheReadTokens: 2700,
        requestCount: 3,
      });

      const second = await collectDeepseek(opts);
      expect(second.filesScanned).toBe(0);
      expect(second.entries).toEqual(first.entries);
    });
  });
});
