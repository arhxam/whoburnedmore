import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectQoder,
  estimateOutputTokens,
  parseQoderJsonl,
  readQoderModels,
} from "../src/native/qoder.js";

// A fixed local-noon so date bucketing is timezone-stable in CI.
const ISO = new Date(2026, 5, 10, 12, 0, 0).toISOString();

/** One assistant turn shaped exactly like Qoder CLI's transcript record. */
function assistantTurn(opts: {
  timestamp?: string;
  model?: string;
  ratio: number;
  text?: string;
  thinking?: string;
}) {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  return JSON.stringify({
    type: "assistant",
    uuid: "u-1",
    timestamp: opts.timestamp ?? ISO,
    message: {
      id: "m-1",
      role: "assistant",
      model: opts.model ?? "dfmodel",
      content,
      // Qoder proxies the model server-side, so the provider's token counts
      // never reach the client — they are always zero.
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        credits: 0.5,
        billable: true,
        request_id: "r-1",
        context_usage_ratio: opts.ratio,
      },
    },
    cwd: "C:\\work",
    sessionId: "s-1",
    version: "1.1.74",
  });
}

function runtimeConfig(model: string, contextWindow: number | null) {
  return JSON.stringify({
    type: "runtime-config",
    sessionId: "s-1",
    model,
    reasoningEffort: null,
    contextWindow,
    generation: null,
    timestamp: Date.parse(ISO),
  });
}

describe("parseQoderJsonl — token reconstruction", () => {
  it("reconstructs input tokens from the context ratio, not the zeroed counters", () => {
    const rows = parseQoderJsonl(assistantTurn({ ratio: 0.5 }));
    expect(rows).toHaveLength(1);
    const [date, modelKey, ratio, outputTokens, windowOverride] = rows[0]!;
    expect(date).toBe("2026-06-10");
    expect(modelKey).toBe("dfmodel");
    expect(ratio).toBe(0.5);
    expect(outputTokens).toBe(0);
    expect(windowOverride).toBeNull();
  });

  it("measures the response body for output tokens", () => {
    const rows = parseQoderJsonl(
      assistantTurn({ ratio: 0.1, text: "x".repeat(400) }),
    );
    expect(rows[0]![3]).toBe(100);
  });

  it("ignores records without a context ratio", () => {
    const noUsage = JSON.stringify({
      type: "assistant",
      timestamp: ISO,
      message: { role: "assistant", model: "dfmodel", content: [] },
    });
    expect(parseQoderJsonl(noUsage)).toHaveLength(0);
    expect(parseQoderJsonl("not json\n\n")).toHaveLength(0);
  });

  it("tracks the runtime-config window override across the file", () => {
    const rows = parseQoderJsonl(
      [
        runtimeConfig("dfmodel", null),
        assistantTurn({ ratio: 0.1 }),
        runtimeConfig("dfmodel", 200000),
        assistantTurn({ ratio: 0.2 }),
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    // Before the override: fall back to the model's own window.
    expect(rows[0]![4]).toBeNull();
    // After the override: the session's explicit window applies.
    expect(rows[1]![4]).toBe(200000);
  });
});

describe("estimateOutputTokens", () => {
  it("is ~4 characters per token for latin text and denser for CJK", () => {
    expect(estimateOutputTokens("")).toBe(0);
    expect(estimateOutputTokens("abcd")).toBe(1);
    expect(estimateOutputTokens("a".repeat(400))).toBe(100);
    // CJK is worth roughly a token per character, so the same number of
    // characters costs more tokens than latin text does.
    expect(estimateOutputTokens("漢".repeat(10))).toBeGreaterThan(
      estimateOutputTokens("a".repeat(10)),
    );
  });
});

describe("readQoderModels — model windows from the run logs", () => {
  it("recovers max_input_tokens from a run log and backfills the built-in tiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qoder-models-"));
    try {
      const runDir = join(dir, "logs", "runs", "2026-06-10T10-00-00-000");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "qodercli.log"),
        [
          "[QoderInferRequest details] model_config=" +
            JSON.stringify({
              key: "qmodel",
              display_name: "Qwen3.8-Flash",
              max_input_tokens: 262144,
            }) +
            ", custom_model=null",
        ].join("\n"),
      );
      const models = await readQoderModels(dir, {
        deadline: Date.now() + 5000,
        now: Date.now,
      });
      expect(models.get("qmodel")).toEqual({
        displayName: "Qwen3.8-Flash",
        maxInputTokens: 262144,
      });
      // Built-in table still covers the tiers the logs never mentioned.
      expect(models.get("dfmodel")?.maxInputTokens).toBe(1_000_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a log larger than the head cap (the common case for long sessions)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qoder-biglog-"));
    try {
      const runDir = join(dir, "logs", "runs", "2026-06-10T10-00-00-000");
      await mkdir(runDir, { recursive: true });
      const head =
        "[QoderInferRequest details] model_config=" +
        JSON.stringify({
          key: "dfmodel",
          display_name: "DeepSeek-Flash",
          max_input_tokens: 1000000,
        }) +
        ", custom_model=null\n";
      // A 20 MB log: a whole-file read would blow the budget, and a
      // whole-file size check would reject it outright.
      await writeFile(join(runDir, "qodercli.log"), head + "x".repeat(20 * 1024 * 1024));
      const models = await readQoderModels(dir, {
        deadline: Date.now() + 10_000,
        now: Date.now,
      });
      expect(models.get("dfmodel")).toEqual({
        displayName: "DeepSeek-Flash",
        maxInputTokens: 1_000_000,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collectQoder — end to end", () => {
  it("is a no-op when Qoder is not installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qoder-empty-"));
    try {
      const res = await collectQoder({ qoderDir: dir, env: {} });
      expect(res.found).toBe(false);
      expect(res.entries).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aggregates a session into one daily entry with a request fingerprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qoder-e2e-"));
    try {
      const proj = join(dir, "projects", "C--work");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, "s-1.jsonl"),
        [
          runtimeConfig("dfmodel", null),
          assistantTurn({ ratio: 0.5, text: "hello" }),
          assistantTurn({ ratio: 0.25, text: "world" }),
        ].join("\n"),
      );
      const res = await collectQoder({
        qoderDir: dir,
        env: {},
        cachePath: join(dir, "cache.json"),
      });
      expect(res.found).toBe(true);
      expect(res.entries).toHaveLength(1);
      const e = res.entries[0]!;
      expect(e.tool).toBe("qoder");
      expect(e.model).toBe("DeepSeek-Flash");
      expect(e.date).toBe("2026-06-10");
      // 0.5 + 0.25 of a 1M window.
      expect(e.inputTokens).toBe(750_000);
      expect(e.requestCount).toBe(2);
      expect(e.origin).toBe("cli");
      expect(e.verified).toBe(false);
      // Qoder exposes no upstream cache split, so we claim none.
      expect(e.cacheCreationTokens).toBe(0);
      expect(e.cacheReadTokens).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies a session's explicit context window over the model's own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qoder-window-"));
    try {
      const proj = join(dir, "projects", "C--work");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, "s-1.jsonl"),
        [
          runtimeConfig("dfmodel", 200000),
          assistantTurn({ ratio: 0.5 }),
        ].join("\n"),
      );
      const res = await collectQoder({
        qoderDir: dir,
        env: {},
        cachePath: join(dir, "cache.json"),
      });
      expect(res.entries).toHaveLength(1);
      // 0.5 of the session's 200k window, not of the model's 1M window.
      expect(res.entries[0]!.inputTokens).toBe(100_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
