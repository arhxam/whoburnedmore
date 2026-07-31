import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VSCODE_CACHE_VERSION,
  aggregateVscodeAgentEntries,
  collectVscodeAgent,
  parseVscodeAgentMessages,
  vscodeGlobalStorageRoots,
} from "../src/native/vscode-agents.js";

/**
 * Build one Cline/Roo `ui_messages.json` `api_req_started` message. Cline writes
 * this row when a provider request STARTS (text = just the request), then
 * UPDATES the same row's `text` in place with the token/cost totals when the
 * request finishes. A finished request therefore carries the token fields.
 */
function apiReq(opts: {
  ts: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheWrites?: number;
  cacheReads?: number;
  cost?: number;
  model?: string;
  /** Cline records the model on the message row as `modelInfo.modelId`. */
  modelId?: string;
  textIsObject?: boolean;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (opts.tokensIn !== undefined) payload.tokensIn = opts.tokensIn;
  if (opts.tokensOut !== undefined) payload.tokensOut = opts.tokensOut;
  if (opts.cacheWrites !== undefined) payload.cacheWrites = opts.cacheWrites;
  if (opts.cacheReads !== undefined) payload.cacheReads = opts.cacheReads;
  if (opts.cost !== undefined) payload.cost = opts.cost;
  if (opts.model !== undefined) payload.model = opts.model;
  const msg: Record<string, unknown> = {
    ts: opts.ts,
    type: "say",
    say: "api_req_started",
    text: opts.textIsObject ? payload : JSON.stringify(payload),
  };
  if (opts.modelId !== undefined) {
    msg.modelInfo = { modelId: opts.modelId, providerId: "anthropic", mode: "act" };
  }
  return msg;
}

const total = (e: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}) =>
  e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;

// A fixed local-noon epoch so date bucketing is timezone-stable in CI.
const TS = new Date(2026, 5, 10, 12, 0, 0).getTime();

describe("aggregateVscodeAgentEntries — token mapping", () => {
  it("maps Cline field names onto the canonical token fields with a request fingerprint", () => {
    const entries = aggregateVscodeAgentEntries("cline", [
      apiReq({ ts: TS, tokensIn: 100, tokensOut: 200, cacheWrites: 30, cacheReads: 40, cost: 0.5 }),
    ]);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.tool).toBe("cline");
    expect(e.inputTokens).toBe(100);
    expect(e.outputTokens).toBe(200);
    expect(e.cacheCreationTokens).toBe(30); // cacheWrites → cacheCreation
    expect(e.cacheReadTokens).toBe(40); // cacheReads → cacheRead
    expect(total(e)).toBe(370);
    expect(e.requestCount).toBe(1);
    expect(e.origin).toBe("cli");
    expect(e.verified).toBe(false);
  });

  it("reads the model from the Cline message row's modelInfo.modelId (it isn't in the api_req_started text)", () => {
    const entries = aggregateVscodeAgentEntries("cline", [
      apiReq({ ts: TS, tokensIn: 100, tokensOut: 20, modelId: "claude-sonnet-4-5" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("claude-sonnet-4-5");
  });

  it("falls back to the tool id as the model when neither modelInfo nor a text model is present (e.g. Roo)", () => {
    const entries = aggregateVscodeAgentEntries("roo", [
      apiReq({ ts: TS, tokensIn: 100, tokensOut: 20 }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("roo");
  });

  it("accepts `text` as an already-parsed object, not only a JSON string", () => {
    const entries = aggregateVscodeAgentEntries("cline", [
      apiReq({ ts: TS, tokensIn: 10, tokensOut: 5, textIsObject: true }),
    ]);
    expect(entries).toHaveLength(1);
    expect(total(entries[0])).toBe(15);
  });
});

describe("aggregateVscodeAgentEntries — cost", () => {
  it("uses the stored cost when Cline recorded one", () => {
    const [e] = aggregateVscodeAgentEntries("cline", [
      apiReq({ ts: TS, tokensIn: 10, tokensOut: 5, cost: 1.25 }),
    ]);
    expect(e.costUSD).toBe(1.25);
  });

  it("estimates cost from the model when none is stored (priced model → >0, unknown → 0)", () => {
    const priced = aggregateVscodeAgentEntries("cline", [
      apiReq({ ts: TS, tokensIn: 1_000_000, tokensOut: 1_000_000, model: "claude-sonnet-4-5" }),
    ]);
    expect(priced[0].costUSD).toBeGreaterThan(0);
    // No model + no stored cost → default model is the tool id (unpriced) → 0.
    const unknown = aggregateVscodeAgentEntries("cline", [
      apiReq({ ts: TS, tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    ]);
    expect(unknown[0].costUSD).toBe(0);
  });
});

describe("aggregateVscodeAgentEntries — grouping & filtering", () => {
  it("groups by local date and model, and passes the tool label through", () => {
    const nextDay = new Date(2026, 5, 11, 12, 0, 0).getTime();
    const entries = aggregateVscodeAgentEntries("roo", [
      apiReq({ ts: TS, tokensIn: 10, model: "claude-sonnet-4-5" }),
      apiReq({ ts: TS, tokensIn: 20, model: "gpt-5" }),
      apiReq({ ts: nextDay, tokensIn: 30, model: "claude-sonnet-4-5" }),
    ]);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.tool === "roo")).toBe(true);
    expect(new Set(entries.map((e) => e.date)).size).toBe(2);
    expect(new Set(entries.map((e) => e.model)).size).toBe(2);
  });

  it("ignores non-request messages, in-progress requests (no tokens), and unparseable text", () => {
    const entries = aggregateVscodeAgentEntries("cline", [
      { ts: TS, type: "ask", ask: "tool", text: "may I?" }, // not a request
      { ts: TS, type: "say", say: "text", text: "thinking…" }, // assistant chatter
      { ts: TS, type: "say", say: "api_req_started", text: JSON.stringify({ request: "GET…" }) }, // started, no tokens yet
      { ts: TS, type: "say", say: "api_req_started", text: "{not valid json" }, // corrupt
      apiReq({ ts: 1, tokensIn: 9 }), // 1970, before coding agents
      apiReq({ ts: Number.MAX_VALUE, tokensIn: 9 }), // invalid Date
      apiReq({ ts: TS, tokensIn: 7 }), // the one real completed request
    ]);
    expect(entries).toHaveLength(1);
    expect(total(entries[0])).toBe(7);
    expect(entries[0].requestCount).toBe(1);
  });

  it("counts each completed request toward requestCount and sums their tokens", () => {
    const [e] = aggregateVscodeAgentEntries("cline", [
      apiReq({ ts: TS, tokensIn: 100, model: "claude-sonnet-4-5" }),
      apiReq({ ts: TS, tokensOut: 50, model: "claude-sonnet-4-5" }),
      apiReq({ ts: TS, cacheReads: 25, model: "claude-sonnet-4-5" }),
    ]);
    expect(total(e)).toBe(175);
    expect(e.requestCount).toBe(3);
  });
});

describe("parseVscodeAgentMessages", () => {
  it("parses a ui_messages.json array string, and yields nothing for non-array / garbage", () => {
    const ok = parseVscodeAgentMessages(
      "cline",
      JSON.stringify([apiReq({ ts: TS, tokensIn: 9 })]),
    );
    expect(ok).toHaveLength(1);
    expect(parseVscodeAgentMessages("cline", "{}")).toEqual([]);
    expect(parseVscodeAgentMessages("cline", "not json")).toEqual([]);
  });
});

describe("vscodeGlobalStorageRoots", () => {
  it("includes the mainline VS Code globalStorage dir for the platform", () => {
    const roots = vscodeGlobalStorageRoots({ HOME: "/home/x" } as NodeJS.ProcessEnv);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((r) => r.endsWith(join("User", "globalStorage")))).toBe(true);
    expect(roots.some((r) => r.includes("Code"))).toBe(true);
  });
});

describe("collectVscodeAgent — reads task dirs on disk", () => {
  it("invalidates caches created before the hardened date semantics", () => {
    expect(VSCODE_CACHE_VERSION).toBe(2);
  });

  it("reads <root>/<extId>/tasks/*/ui_messages.json and aggregates, or found:false when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-vscode-"));
    const extId = "saoudrizwan.claude-dev";
    const taskDir = join(dir, extId, "tasks", "task-1");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "ui_messages.json"),
      JSON.stringify([
        apiReq({ ts: TS, tokensIn: 100, tokensOut: 20, cost: 0.3, model: "claude-sonnet-4-5" }),
      ]),
    );
    const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const res = await collectVscodeAgent({
        tool: "cline",
        extIds: [extId],
        roots: [dir],
        env,
        cachePath: join(dir, "cache.json"),
      });
      expect(res.found).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0].tool).toBe("cline");
      expect(total(res.entries[0])).toBe(120);
      expect(res.entries[0].requestCount).toBe(1);

      // A root with no matching extension dir → found:false (clean no-op).
      const empty = await collectVscodeAgent({
        tool: "cline",
        extIds: ["does.not.exist"],
        roots: [dir],
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
