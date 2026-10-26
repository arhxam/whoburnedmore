import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentIdFor,
  CCUSAGE_AGENT_IDS,
  collectDiscovered,
  extractUsageRows,
} from "../src/native/discover.js";

// A fixed local-noon so date bucketing is timezone-stable in CI.
const ISO = new Date(2026, 5, 10, 12, 0, 0).toISOString();
const EPOCH_MS = new Date(2026, 5, 10, 12, 0, 0).getTime();

/** A Claude-Code-style assistant turn — the de-facto standard fork shape. */
function claudeStyle(opts: {
  model?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  id?: string;
  requestId?: string;
}) {
  return JSON.stringify({
    type: "assistant",
    uuid: "u-1",
    timestamp: ISO,
    message: {
      id: opts.id ?? "m-1",
      role: "assistant",
      model: opts.model ?? "claude-sonnet-4-6",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: opts.input ?? 100,
        output_tokens: opts.output ?? 20,
        cache_creation_input_tokens: opts.cacheCreation ?? 5,
        cache_read_input_tokens: opts.cacheRead ?? 300,
      },
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    },
    cwd: "C:\\work",
    sessionId: "s-1",
  });
}

describe("extractUsageRows — shape detection", () => {
  it("reads the Claude-style shape, including the cache buckets", () => {
    const rows = extractUsageRows(
      claudeStyle({ input: 100, output: 20, cacheCreation: 5, cacheRead: 300 }),
      "fallback",
    );
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.date).toBe("2026-06-10");
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(20);
    expect(r.cacheCreationTokens).toBe(5);
    expect(r.cacheReadTokens).toBe(300);
  });

  it("reads the OpenCode-style shape, counting reasoning as output", () => {
    const line = JSON.stringify({
      role: "assistant",
      time: { created: EPOCH_MS },
      modelID: "grok-code",
      providerID: "opencode",
      tokens: { input: 11067, output: 26, reasoning: 753, cache: { read: 320, write: 0 } },
    });
    const rows = extractUsageRows(line, "fallback");
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.date).toBe("2026-06-10");
    expect(r.model).toBe("grok-code");
    expect(r.inputTokens).toBe(11067);
    // reasoning tokens are generated tokens
    expect(r.outputTokens).toBe(26 + 753);
    expect(r.cacheReadTokens).toBe(320);
  });

  it("reads a camelCase usage object", () => {
    const line = JSON.stringify({
      timestamp: ISO,
      model: "some-model",
      usage: {
        inputTokens: 11,
        outputTokens: 22,
        cacheCreationTokens: 33,
        cacheReadTokens: 44,
      },
    });
    const rows = extractUsageRows(line, "fallback");
    expect(rows[0]!.inputTokens).toBe(11);
    expect(rows[0]!.outputTokens).toBe(22);
    expect(rows[0]!.cacheCreationTokens).toBe(33);
    expect(rows[0]!.cacheReadTokens).toBe(44);
  });

  it("falls back to the tool id when the agent records no model", () => {
    const line = JSON.stringify({
      timestamp: ISO,
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    expect(extractUsageRows(line, "myagent")[0]!.model).toBe("myagent");
  });

  it("ignores a user/tool_result record that repeats the assistant turn's usage", () => {
    // Claude Code (and the transcripts that copy its format) replicate the
    // previous assistant turn's `usage` onto the FOLLOWING user/tool_result
    // record. Counting that would count every request twice. This is a real
    // shape we hit in live transcripts, not a hypothetical.
    const assistant = claudeStyle({ input: 100, output: 20, id: "m-1" });
    const echoedUser = JSON.stringify({
      type: "user",
      timestamp: ISO,
      parentUuid: "u-1",
      message: {
        role: "user",
        content: [{ tool_use_id: "t-1", type: "tool_result", content: "ok" }],
        // the same usage, echoed onto the user turn
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 300,
        },
      },
    });
    const rows = extractUsageRows(`${assistant}\n${echoedUser}`, "agentid");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(100);
    expect(rows[0]!.model).toBe("claude-sonnet-4-6");
  });

  it("produces nothing for records without tokens, a timestamp, or both", () => {    // No usage at all.
    expect(extractUsageRows(JSON.stringify({ type: "user", message: {} }), "a")).toHaveLength(0);
    // A usage object whose counters are all zero (Qoder's shape).
    expect(
      extractUsageRows(
        JSON.stringify({
          timestamp: ISO,
          message: { model: "m", usage: { input_tokens: 0, output_tokens: 0 } },
        }),
        "a",
      ),
    ).toHaveLength(0);
    // Tokens but no timestamp.
    expect(
      extractUsageRows(
        JSON.stringify({ message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
        "a",
      ),
    ).toHaveLength(0);
    // Not JSON at all.
    expect(extractUsageRows("hello\nworld", "a")).toHaveLength(0);
  });
});

describe("agentIdFor", () => {
  it("derives the agent id from the directory name", () => {
    expect(agentIdFor(".qoder")).toBe("qoder");
    expect(agentIdFor(".trae")).toBe("trae");
  });

  it("maps the directories whose agent id differs from the folder name", () => {
    // ccusage calls Factory "droid"; the directory is ~/.factory.
    expect(agentIdFor(".factory")).toBe("droid");
  });
});

describe("collectDiscovered — discovery", () => {
  it("finds an agent nobody listed, reads its models, and adds it", async () => {
    const home = await mkdtemp(join(tmpdir(), "discover-home-"));
    try {
      const proj = join(home, ".brandnewcli", "projects", "C--work");
      await mkdir(proj, { recursive: true });
      await writeFile(
        join(proj, "s-1.jsonl"),
        [
          claudeStyle({ model: "brandnew-model-a", input: 100, output: 10, id: "m-a" }),
          claudeStyle({ model: "brandnew-model-b", input: 50, output: 5, id: "m-b" }),
        ].join("\n"),
      );
      const res = await collectDiscovered({
        env: { HOME: home },
        cachePath: join(home, "cache.json"),
      });
      expect(res.found).toBe(true);
      expect(res.entries).toHaveLength(2);
      // The tool id is the directory; the MODEL comes from the data.
      expect(new Set(res.entries.map((e) => e.tool))).toEqual(
        new Set(["brandnewcli"]),
      );
      expect(new Set(res.entries.map((e) => e.model))).toEqual(
        new Set(["brandnew-model-a", "brandnew-model-b"]),
      );
      expect(res.agents).toHaveLength(1);
      expect(res.agents[0]!.id).toBe("brandnewcli");
      expect(res.agents[0]!.models).toEqual(["brandnew-model-a", "brandnew-model-b"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("skips an agent ccusage already covers, so nothing is counted twice", async () => {
    const home = await mkdtemp(join(tmpdir(), "discover-skip-"));
    try {
      const proj = join(home, ".claude", "projects", "C--work");
      await mkdir(proj, { recursive: true });
      await writeFile(join(proj, "s-1.jsonl"), claudeStyle({ input: 999 }));
      const res = await collectDiscovered({
        env: { HOME: home },
        cachePath: join(home, "cache.json"),
      });
      expect(res.entries).toHaveLength(0);
      expect(res.found).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("skips the agents our own native readers own", async () => {
    const home = await mkdtemp(join(tmpdir(), "discover-native-"));
    try {
      for (const dir of [".qoder", ".cursor", ".continue", ".cline", ".roo"]) {
        const proj = join(home, dir, "projects");
        await mkdir(proj, { recursive: true });
        await writeFile(join(proj, "s-1.jsonl"), claudeStyle({ input: 999 }));
      }
      const res = await collectDiscovered({
        env: { HOME: home },
        cachePath: join(home, "cache.json"),
      });
      expect(res.entries).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("skips an agent the caller says ccusage reported this run", async () => {
    const home = await mkdtemp(join(tmpdir(), "discover-runtime-"));
    try {
      const proj = join(home, ".newccusageagent", "projects");
      await mkdir(proj, { recursive: true });
      await writeFile(join(proj, "s-1.jsonl"), claudeStyle({ input: 999 }));
      const res = await collectDiscovered({
        env: { HOME: home },
        cachePath: join(home, "cache.json"),
        // A ccusage release added this agent; it counted it, so we must not.
        skipAgentIds: ["newccusageagent"],
      });
      expect(res.entries).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("collapses a duplicated request (a forked session) instead of doubling it", async () => {
    const home = await mkdtemp(join(tmpdir(), "discover-fork-"));
    try {
      const proj = join(home, ".forky", "projects");
      await mkdir(proj, { recursive: true });
      const line = claudeStyle({
        input: 100,
        output: 10,
        id: "msg-1",
        requestId: "req-1",
      });
      // The same request written into two files, as a fork does.
      await writeFile(join(proj, "a.jsonl"), line);
      await writeFile(join(proj, "b.jsonl"), line);
      const res = await collectDiscovered({
        env: { HOME: home },
        cachePath: join(home, "cache.json"),
      });
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0]!.inputTokens).toBe(100);
      expect(res.entries[0]!.requestCount).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("is a no-op when no agent home has any usage", async () => {
    const home = await mkdtemp(join(tmpdir(), "discover-empty-"));
    try {
      const proj = join(home, ".emptycli", "projects");
      await mkdir(proj, { recursive: true });
      await writeFile(join(proj, "s-1.jsonl"), JSON.stringify({ type: "user" }));
      const res = await collectDiscovered({
        env: { HOME: home },
        cachePath: join(home, "cache.json"),
      });
      expect(res.found).toBe(false);
      expect(res.entries).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("CCUSAGE_AGENT_IDS", () => {
  it("covers the agents ccusage reads, so the generic reader cannot double them", () => {
    for (const id of [
      "claude",
      "codex",
      "opencode",
      "amp",
      "gemini",
      "droid",
      "antigravity",
      "grok",
      "zcode",
    ]) {
      expect(CCUSAGE_AGENT_IDS.has(id)).toBe(true);
    }
  });
});
