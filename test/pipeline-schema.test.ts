import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyUsageEntry, SubmitPayload } from "../src/shared.js";
import { collectVscodeAgent } from "../src/native/vscode-agents.js";
import { collectContinue } from "../src/continue.js";
import { dedupeDaily } from "../src/collect.js";

/**
 * End-to-end guarantee for the NEW readers: whatever they read off disk must be
 * a SERVER-VALID payload. We build realistic on-disk fixtures, run the real
 * collectors, merge exactly as collectAll does (dedupeDaily), and validate the
 * result against the shared zod schema the API actually enforces. A field-name
 * or shape regression that would make the server 400 fails here.
 */
const TS = new Date(2026, 5, 10, 12, 0, 0).getTime();
const ISO = new Date(2026, 5, 10, 12, 0, 0).toISOString();

function apiReq(o: { ts: number; tokensIn?: number; tokensOut?: number; cacheWrites?: number; cacheReads?: number; cost?: number; modelId?: string }) {
  const p: Record<string, unknown> = {};
  if (o.tokensIn !== undefined) p.tokensIn = o.tokensIn;
  if (o.tokensOut !== undefined) p.tokensOut = o.tokensOut;
  if (o.cacheWrites !== undefined) p.cacheWrites = o.cacheWrites;
  if (o.cacheReads !== undefined) p.cacheReads = o.cacheReads;
  if (o.cost !== undefined) p.cost = o.cost;
  const msg: Record<string, unknown> = { ts: o.ts, type: "say", say: "api_req_started", text: JSON.stringify(p) };
  // Cline records the model on the row (modelInfo.modelId), not in the text.
  if (o.modelId !== undefined) msg.modelInfo = { modelId: o.modelId, providerId: "anthropic", mode: "act" };
  return msg;
}

describe("reading pipeline → server-valid payload", () => {
  it("Cline + Roo + Continue readers produce entries that pass DailyUsageEntry and SubmitPayload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-pipe-"));
    try {
      // Cline + Roo globalStorage tasks under one fake editor root.
      const root = join(dir, "vscode");
      for (const [ext, model] of [
        ["saoudrizwan.claude-dev", "claude-sonnet-4-5"],
        ["rooveterinaryinc.roo-cline", "gpt-5"],
      ] as const) {
        const t = join(root, ext, "tasks", "task-1");
        await mkdir(t, { recursive: true });
        await writeFile(
          join(t, "ui_messages.json"),
          JSON.stringify([
            apiReq({ ts: TS, tokensIn: 1200, tokensOut: 340, cacheWrites: 50, cacheReads: 900, cost: 0.42, modelId: model }),
            apiReq({ ts: TS, tokensIn: 800, tokensOut: 120, modelId: model }),
          ]),
        );
      }
      // Continue dev_data.
      const cont = join(dir, "continue", "dev_data", "0.2.0");
      await mkdir(cont, { recursive: true });
      await writeFile(
        join(cont, "tokensGenerated.jsonl"),
        [
          JSON.stringify({ model: "claude-sonnet-4-5", provider: "anthropic", promptTokens: 500, generatedTokens: 90, timestamp: ISO }),
          JSON.stringify({ model: "claude-sonnet-4-5", provider: "anthropic", promptTokens: 30, generatedTokens: 10, timestamp: ISO }),
        ].join("\n") + "\n",
      );

      const env = { WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      const cline = await collectVscodeAgent({ tool: "cline", extIds: ["saoudrizwan.claude-dev"], roots: [root], env, cachePath: join(dir, "c1.json") });
      const roo = await collectVscodeAgent({ tool: "roo", extIds: ["rooveterinaryinc.roo-cline"], roots: [root], env, cachePath: join(dir, "c2.json") });
      const cont2 = await collectContinue({ continueDir: join(dir, "continue"), env, cachePath: join(dir, "c3.json") });

      expect(cline.found && roo.found && cont2.found).toBe(true);
      const all = dedupeDaily([...cline.entries, ...roo.entries, ...cont2.entries]);

      // Every entry is individually schema-valid…
      for (const e of all) expect(() => DailyUsageEntry.parse(e)).not.toThrow();
      // …and the whole thing is a valid SubmitPayload the API would accept.
      const payload = { cliVersion: "0.9.16", entries: all };
      expect(() => SubmitPayload.parse(payload)).not.toThrow();

      // The three tools are all present with real request fingerprints.
      const tools = new Set(all.map((e) => e.tool));
      expect(tools).toEqual(new Set(["cline", "roo", "continue"]));
      expect(all.every((e) => (e.requestCount ?? 0) >= 1)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
