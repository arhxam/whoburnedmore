import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AUTOCLAW_CACHE_VERSION,
  aggregateAutoclawLines,
  autoclawRoots,
  autoclawSessionId,
  collectAutoclaw,
  parseAutoclawLine,
} from "../src/autoclaw.js";

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

/** An assistant turn shaped exactly like AutoClaw writes it. */
const turn = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "message",
    id: "916258b3",
    parentId: "83bd2f01",
    timestamp: ISO,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "zai",
      model: "tdpsk_deepseek-v4-flash-202605",
      stopReason: "toolUse",
      timestamp: EPOCH_MS,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 8,
        cacheWrite: 0,
        reasoningTokens: 4,
        totalTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    ...over,
  });

describe("parseAutoclawLine — the real AutoClaw envelope", () => {
  it("maps an assistant turn's usage (input/output/cacheRead/cacheWrite) with a request fingerprint", () => {
    const r = parseAutoclawLine(turn(), "s1");
    expect(r).not.toBeNull();
    expect(r!.date).toBe("2026-06-10");
    expect(r!.model).toBe("tdpsk_deepseek-v4-flash-202605");
    expect(r!.inputTokens).toBe(100);
    expect(r!.outputTokens).toBe(20);
    expect(r!.cacheReadTokens).toBe(8);
    expect(r!.cacheCreationTokens).toBe(0);
    expect(r!.hasRealId).toBe(true);
    expect(r!.key).toBe("s1|916258b3");
  });

  it("does NOT add reasoningTokens to the total — they are a subset of output", () => {
    const r = parseAutoclawLine(turn(), "s1")!;
    expect(total(r)).toBe(128); // 100 + 20 + 8, not 132
  });

  it("falls back to the message-level epoch-ms timestamp when the envelope has none", () => {
    const line = turn({ timestamp: undefined });
    const r = parseAutoclawLine(line, "s1");
    expect(r?.date).toBe("2026-06-10");
  });

  it("ignores non-message lines, non-assistant roles, and usage-less turns", () => {
    expect(parseAutoclawLine(JSON.stringify({ type: "model_change", id: "x" }), "s1")).toBeNull();
    expect(
      parseAutoclawLine(
        JSON.stringify({
          type: "message",
          id: "a",
          timestamp: ISO,
          message: { role: "user", content: "hi" },
        }),
        "s1",
      ),
    ).toBeNull();
    expect(
      parseAutoclawLine(
        JSON.stringify({
          type: "message",
          id: "a",
          timestamp: ISO,
          message: { role: "assistant", model: "m" },
        }),
        "s1",
      ),
    ).toBeNull();
  });

  it("skips a turn whose four token buckets are all zero", () => {
    const line = turn();
    const obj = JSON.parse(line);
    obj.message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(parseAutoclawLine(JSON.stringify(obj), "s1")).toBeNull();
  });

  it("skips unparseable JSON, blank lines, and an unparseable/far-future date", () => {
    expect(parseAutoclawLine("", "s1")).toBeNull();
    expect(parseAutoclawLine("not json", "s1")).toBeNull();
    expect(parseAutoclawLine(turn({ timestamp: "1970-01-01T00:00:00.000Z" }), "s1")).toBeNull();
    expect(parseAutoclawLine(turn({ timestamp: "bogus", message: { role: "assistant", usage: { input: 1 }, timestamp: 1 } }), "s1")).toBeNull();
  });

  it("also reads the snake_case bucket names an OpenAI-shaped payload would carry", () => {
    const obj = JSON.parse(turn());
    obj.message.usage = {
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    };
    const r = parseAutoclawLine(JSON.stringify(obj), "s1")!;
    expect(total(r)).toBe(13);
    expect(r.cacheReadTokens).toBe(2);
    expect(r.cacheCreationTokens).toBe(1);
  });

  it("mints distinct synthetic keys for id-less turns so they are never merged away", () => {
    const line = turn({ id: undefined });
    const a = parseAutoclawLine(line, "s1")!;
    const b = parseAutoclawLine(line, "s1")!;
    expect(a.hasRealId).toBe(false);
    expect(a.key).not.toBe(b.key);
  });

  it("treats a provider responseId as real request identity when the line id is gone", () => {
    const obj = JSON.parse(turn({ id: undefined }));
    obj.message.responseId = "resp_abc";
    const r = parseAutoclawLine(JSON.stringify(obj), "s1")!;
    expect(r.hasRealId).toBe(true);
    expect(r.key).toBe("s1|response:resp_abc");
  });

  it("keeps a recorded cost when AutoClaw wrote one, and null on the 0-cost credit plan", () => {
    // AutoClaw's subscription/credit plan records cost.total = 0 on every turn.
    expect(parseAutoclawLine(turn(), "s1")!.storedCost).toBeNull();
    const obj = JSON.parse(turn());
    obj.message.usage.cost.total = 0.42;
    expect(parseAutoclawLine(JSON.stringify(obj), "s1")!.storedCost).toBe(0.42);
  });
});

describe("aggregateAutoclawLines — grouping & dedup", () => {
  it("publishes tool=autoclaw with the standard entry shape", () => {
    const entries = aggregateAutoclawLines([turn()], "s1");
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.tool).toBe("autoclaw");
    expect(e.model).toBe("tdpsk_deepseek-v4-flash-202605");
    expect(total(e)).toBe(128);
    expect(e.requestCount).toBe(1);
    expect(e.origin).toBe("cli");
    expect(e.verified).toBe(false);
  });

  it("keeps the MAXIMAL occurrence of a replayed line id (no under- or over-count)", () => {
    const partial = turn({ id: "same" });
    const obj = JSON.parse(partial);
    obj.message.usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
    const streamed = JSON.stringify(obj);
    const entries = aggregateAutoclawLines([streamed, turn({ id: "same" })], "s1");
    expect(entries).toHaveLength(1);
    expect(total(entries[0])).toBe(128); // final counts, not 30 and not 158
    expect(entries[0].requestCount).toBe(1);
  });

  it("never dedups across sessions that reuse the same line id", () => {
    const a = aggregateAutoclawLines([turn({ id: "dup" })], "s1");
    const b = aggregateAutoclawLines([turn({ id: "dup" })], "s2");
    expect(total(a[0])).toBe(128);
    expect(total(b[0])).toBe(128);
  });

  it("groups by local date and model", () => {
    const nextDay = new Date(2026, 5, 11, 12, 0, 0).toISOString();
    const other = JSON.parse(turn({ id: "c" }));
    other.message.model = "zaicoding_glm-5.3";
    const entries = aggregateAutoclawLines(
      [turn({ id: "a" }), turn({ id: "b", timestamp: nextDay }), JSON.stringify(other)],
      "s1",
    );
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.date)).size).toBe(2);
    expect(new Set(entries.map((e) => e.model)).size).toBe(2);
  });

  it("sums many turns of one day into a single row", () => {
    const entries = aggregateAutoclawLines(
      [turn({ id: "a" }), turn({ id: "b" }), turn({ id: "c" })],
      "s1",
    );
    expect(entries).toHaveLength(1);
    expect(total(entries[0])).toBe(3 * 128);
    expect(entries[0].requestCount).toBe(3);
  });

  it("estimates cost from the model (a GLM/deepseek family id prices; an unknown one is $0)", () => {
    const priced = aggregateAutoclawLines([turn()], "s1");
    expect(priced[0].costUSD).toBeGreaterThan(0);
    const unknown = aggregateAutoclawLines(
      [turn({ message: { ...JSON.parse(turn()).message, model: "some-unlisted-model" } })],
      "s1",
    );
    expect(unknown[0].costUSD).toBe(0);
  });

  it("prefers a recorded per-turn cost over the estimate", () => {
    const obj = JSON.parse(turn());
    obj.message.usage.cost.total = 5;
    expect(aggregateAutoclawLines([JSON.stringify(obj)], "s1")[0].costUSD).toBe(5);
  });
});

describe("autoclawRoots / autoclawSessionId", () => {
  it("defaults to the ~/.openclaw-autoclaw state dir the desktop app launches", () => {
    const home = join("/tmp", "wbm-home");
    expect(autoclawRoots({ HOME: home } as NodeJS.ProcessEnv)).toEqual([
      join(home, ".openclaw-autoclaw"),
    ]);
  });

  it("honors the state-dir env overrides", () => {
    const env = {
      HOME: "/tmp/x",
      AUTOCLAW_STATE_DIR: "/data/ac",
    } as NodeJS.ProcessEnv;
    expect(autoclawRoots(env)).toEqual(["/data/ac"]);
    expect(
      autoclawRoots({ HOME: "/tmp/x", OPENCLAW_STATE_DIR: "/data/oc" } as NodeJS.ProcessEnv),
    ).toEqual(["/data/oc"]);
  });

  it("derives the session id from the transcript filename", () => {
    expect(autoclawSessionId("/a/b/2c4a3225-4c17-40ab-bd06-49df22c9e85d.jsonl")).toBe(
      "2c4a3225-4c17-40ab-bd06-49df22c9e85d",
    );
  });
});

describe("collectAutoclaw — reads agents/*/sessions on disk", () => {
  const writeSession = async (
    root: string,
    agent: string,
    file: string,
    body: string,
  ) => {
    const dir = join(root, "agents", agent, "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), body);
  };

  it("pins the cache version so a parse change invalidates stale rows", () => {
    expect(AUTOCLAW_CACHE_VERSION).toBe(1);
  });

  it("aggregates transcripts across agents, ignoring the no-usage sidecars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-autoclaw-"));
    const root = join(dir, ".openclaw-autoclaw");
    const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      await writeSession(root, "main", "s1.jsonl", `${turn({ id: "a" })}\n`);
      await writeSession(
        root,
        "auto-coder",
        "s2.jsonl",
        `${turn({ id: "b" })}\n${turn({ id: "c" })}\n`,
      );
      // The trace sidecar carries no usage block and must never be read.
      await writeSession(
        root,
        "main",
        "s1.trajectory.jsonl",
        `${JSON.stringify({ type: "model.completed", modelId: "m" })}\n`,
      );
      await writeSession(root, "main", "s1.trajectory-path.json", "{}\n");
      await writeSession(root, "main", "s1.jsonl.lock", "{}\n");

      const res = await collectAutoclaw({
        env,
        roots: [root],
        cachePath: join(dir, "cache.json"),
      });
      expect(res.found).toBe(true);
      expect(res.filesScanned).toBe(2); // only the two real transcripts
      const grand = res.entries.reduce((n, e) => n + total(e), 0);
      expect(grand).toBe(3 * 128);
      const requests = res.entries.reduce((n, e) => n + (e.requestCount ?? 0), 0);
      expect(requests).toBe(3);
      expect(res.entries.every((e) => e.tool === "autoclaw")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedups a forked session that replays another file's request ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-autoclaw-fork-"));
    const root = join(dir, ".openclaw-autoclaw");
    const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      // Two files named after the SAME session id, each holding the same turn.
      await writeSession(root, "main", "s1.jsonl", `${turn({ id: "a" })}\n`);
      await mkdir(join(root, "agents", "work", "sessions"), { recursive: true });
      await writeFile(
        join(root, "agents", "work", "sessions", "s1.jsonl"),
        `${turn({ id: "a" })}\n`,
      );
      const res = await collectAutoclaw({
        env,
        roots: [root],
        cachePath: join(dir, "cache.json"),
      });
      const grand = res.entries.reduce((n, e) => n + total(e), 0);
      expect(grand).toBe(128);
      expect(res.entries[0].requestCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a clean no-op (found:false) when AutoClaw is not installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-autoclaw-none-"));
    const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const res = await collectAutoclaw({
        env,
        roots: [join(dir, ".openclaw-autoclaw")],
        cachePath: join(dir, "cache.json"),
      });
      expect(res).toEqual({ entries: [], found: false, filesScanned: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors a state-dir override instead of the default root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-autoclaw-override-"));
    const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      await writeSession(join(dir, "elsewhere"), "main", "s1.jsonl", `${turn({ id: "a" })}\n`);
      const res = await collectAutoclaw({
        env,
        cachePath: join(dir, "cache.json"),
        roots: [join(dir, "elsewhere")],
      });
      expect(res.found).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(basename(join(dir, "elsewhere"))).toBe("elsewhere");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts rather than submitting a partial corpus when the file cap is exceeded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-autoclaw-cap-"));
    const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const root = join(dir, ".openclaw-autoclaw");
      for (let i = 0; i < 3; i += 1) {
        await writeSession(root, "main", `s${i}.jsonl`, `${turn({ id: `a${i}` })}\n`);
      }
      const res = await collectAutoclaw({
        env,
        roots: [root],
        cachePath: join(dir, "cache.json"),
        maxFiles: 2,
      });
      expect(res).toMatchObject({ entries: [], found: false, timedOut: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
