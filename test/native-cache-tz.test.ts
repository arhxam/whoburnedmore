import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectClaudeNative } from "../src/native/claude.js";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

describe("native parse cache and timezone changes", () => {
  it("re-buckets cached transcripts after the timezone changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "wbm-tz-"));
    const proj = join(root, "claude", "projects", "p");
    mkdirSync(proj, { recursive: true });
    const line = (id: string, ts: string) =>
      JSON.stringify({
        timestamp: ts,
        requestId: `req_${id}`,
        message: { id: `msg_${id}`, role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 10 } },
      });
    writeFileSync(join(proj, "a.jsonl"), `${line("a", "2026-11-05T23:30:00Z")}\n`);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, "claude"), WHOBURNEDMORE_CONFIG_DIR: join(root, "cfg") };
    const cachePath = join(root, "cfg", "native-cache-claude.json");
    const days = (r: { entries: Array<{ date: string; inputTokens: number }> }) =>
      r.entries.map((e) => [e.date, e.inputTokens]);

    process.env.TZ = "UTC";
    await collectClaudeNative(env, { cachePath });

    // Same two requests, now 08:30 and 08:40 on Nov 6 in Tokyo.
    process.env.TZ = "Asia/Tokyo";
    writeFileSync(join(proj, "b.jsonl"), `${line("b", "2026-11-05T23:40:00Z")}\n`);
    const cached = await collectClaudeNative(env, { cachePath });
    const fresh = await collectClaudeNative(env, { cachePath: join(root, "nocache.json") });
    expect(days(fresh)).toEqual([["2026-11-06", 200]]);
    expect(days(cached)).toEqual(days(fresh));
  });
});
