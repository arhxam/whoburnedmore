import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTRIBUTION_CACHE_VERSION,
  TIME_BUDGET_MS,
  parseClaudeAttrFile,
} from "../src/attribution.js";
import { NATIVE_READ_BUDGET_MS } from "../src/native/claude.js";
import { readFilesWithCache } from "../src/native/file-cache.js";

/** One Claude Code assistant transcript line: a tool_use + usage + sessionId. */
function claudeLine(): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-1",
    isSidechain: false,
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 40,
      },
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
    },
  });
}

describe("attribution scan — budget", () => {
  it("TIME_BUDGET_MS is raised to the native readers' budget (45s)", () => {
    // The scan used to run on a 12s budget; it now shares the native readers'
    // value, imported (not re-declared) so the two never drift apart.
    expect(TIME_BUDGET_MS).toBe(NATIVE_READ_BUDGET_MS);
    expect(TIME_BUDGET_MS).toBe(45_000);
  });
});

describe("attribution scan — persistent per-file cache", () => {
  it("a cache hit returns the stored parse without re-reading the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-attrcache-"));
    try {
      const f = join(dir, "s.jsonl");
      await writeFile(f, claudeLine() + "\n");
      const cachePath = join(dir, "cache.json");
      let parses = 0;
      const parse = (content: string) => {
        parses += 1;
        return parseClaudeAttrFile(content);
      };

      const first = await readFilesWithCache({
        files: [f],
        cachePath,
        version: ATTRIBUTION_CACHE_VERSION,
        parseFile: parse,
        deadline: Date.now() + 5000,
      });
      expect(first.filesRead).toBe(1);
      expect(parses).toBe(1);
      // The per-file rollup: one Bash tool call, 200-token turn, one session.
      const firstAgg = first.itemsByFile![0][0];
      expect(firstAgg.tools).toEqual([["Bash", 1, 0, 200]]);
      expect(firstAgg.agent).toEqual([1, 0, 0, 200, 0]);
      expect(firstAgg.sessions).toEqual([["sess-1", 1]]);

      // Second pass over the unchanged file: served from cache, parseFile is
      // NOT invoked again, and the stored parse comes back byte-identical.
      const second = await readFilesWithCache({
        files: [f],
        cachePath,
        version: ATTRIBUTION_CACHE_VERSION,
        parseFile: parse,
        deadline: Date.now() + 5000,
      });
      expect(second.filesRead).toBe(0);
      expect(parses).toBe(1);
      expect(second.itemsByFile![0][0]).toEqual(firstAgg);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an ATTRIBUTION_CACHE_VERSION bump invalidates the cache (forces a re-parse)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-attrcache-"));
    try {
      const f = join(dir, "s.jsonl");
      await writeFile(f, claudeLine() + "\n");
      const cachePath = join(dir, "cache.json");
      let parses = 0;
      const parse = (content: string) => {
        parses += 1;
        return parseClaudeAttrFile(content);
      };

      const v1 = await readFilesWithCache({
        files: [f],
        cachePath,
        version: ATTRIBUTION_CACHE_VERSION,
        parseFile: parse,
        deadline: Date.now() + 5000,
      });
      expect(v1.filesRead).toBe(1);
      expect(parses).toBe(1);

      // Same file, same (size, mtime), but a bumped cache version: the stored
      // entry is discarded and the file is re-parsed from scratch.
      const v2 = await readFilesWithCache({
        files: [f],
        cachePath,
        version: ATTRIBUTION_CACHE_VERSION + 1,
        parseFile: parse,
        deadline: Date.now() + 5000,
      });
      expect(v2.filesRead).toBe(1);
      expect(parses).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
