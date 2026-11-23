import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectClaudeNative, parseClaudeLine } from "../src/native/claude.js";
import { collectCodexNative, inspectCodexRollout, parseCodexRollout } from "../src/native/codex.js";

// Valid JSON that is not an object used to throw inside the readers: Claude's
// whole native read was abandoned and Codex's read rejected without saving its cache.
describe("non-object JSONL lines", () => {
  it("are skipped by the line parsers", () => {
    for (const line of ["null", "42", '"text"', "true"]) {
      expect(parseClaudeLine(line)).toBeNull();
      expect(() => inspectCodexRollout([line])).not.toThrow();
      expect(parseCodexRollout([line])).toEqual([]);
    }
  });

  it("do not abandon a Claude native read", async () => {
    const root = mkdtempSync(join(tmpdir(), "wbm-null-"));
    const proj = join(root, "claude", "projects", "p");
    mkdirSync(proj, { recursive: true });
    const good = JSON.stringify({
      timestamp: "2026-11-05T10:00:00Z",
      requestId: "req_a",
      message: { id: "msg_a", role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 10 } },
    });
    writeFileSync(join(proj, "s.jsonl"), `${good}\nnull\n`);
    const r = await collectClaudeNative(
      { ...process.env, CLAUDE_CONFIG_DIR: join(root, "claude") },
      { cachePath: join(root, "c.json") },
    );
    expect(r.found).toBe(true);
    expect(r.timedOut).not.toBe(true);
    expect(r.entries.reduce((a, e) => a + e.inputTokens, 0)).toBe(100);
  });

  it("do not reject a Codex native read", async () => {
    const root = mkdtempSync(join(tmpdir(), "wbm-null-"));
    const sess = join(root, "codex", "sessions", "2026", "11", "05");
    mkdirSync(sess, { recursive: true });
    writeFileSync(join(sess, "rollout-x.jsonl"), "null\n");
    await expect(
      collectCodexNative({ ...process.env, CODEX_HOME: join(root, "codex") }, { cachePath: join(root, "cx.json") }),
    ).resolves.toBeDefined();
  });
});
