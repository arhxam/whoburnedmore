import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectClaudeNative } from "../src/native/claude.js";
import { collectCodexNative } from "../src/native/codex.js";
import { nativeCachePath, readFilesWithCache } from "../src/native/file-cache.js";

/** Build one Claude Code transcript JSONL line with real provider ids. */
function claudeLine(opts: {
  ts: string;
  model?: string;
  reqId: string;
  msgId: string;
  output?: number;
  input?: number;
}): string {
  return JSON.stringify({
    timestamp: opts.ts,
    requestId: opts.reqId,
    message: {
      role: "assistant",
      id: opts.msgId,
      model: opts.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

/** Build a codex rollout: meta line + one cumulative token_count per entry. */
function codexRollout(model: string, counts: Array<{ ts: string; input: number; output: number }>): string {
  const lines = [
    JSON.stringify({ timestamp: counts[0]?.ts ?? "2026-06-10T10:00:00Z", type: "session_meta", payload: { model } }),
    ...counts.map((c) =>
      JSON.stringify({
        timestamp: c.ts,
        type: "event_msg",
        payload: { type: "token_count", input_tokens: c.input, output_tokens: c.output },
      }),
    ),
  ];
  return lines.join("\n") + "\n";
}

async function makeClaudeCorpus(): Promise<{ dir: string; env: NodeJS.ProcessEnv; proj: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wbm-ncache-"));
  const proj = join(dir, "projects", "p");
  await mkdir(proj, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: dir, WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
  return { dir, env, proj };
}

/** Force a file's mtime back so an in-test rewrite is seen as "changed" only when meant to be. */
async function backdate(path: string, seconds: number): Promise<void> {
  const s = await stat(path);
  const t = new Date(s.mtimeMs - seconds * 1000);
  await utimes(path, t, t);
}

describe("readFilesWithCache — generic cache mechanics", () => {
  it("unchanged-not-reread: second pass parses zero files, same items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-fcache-"));
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      await writeFile(a, "alpha");
      await writeFile(b, "beta");
      const cachePath = join(dir, "cache.json");
      const parse = (content: string) => [content.toUpperCase()];
      const first = await readFilesWithCache({ files: [a, b], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      expect(first.filesRead).toBe(2);
      expect(first.itemsByFile).toEqual([["ALPHA"], ["BETA"]]);
      const second = await readFilesWithCache({ files: [a, b], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      expect(second.filesRead).toBe(0);
      expect(second.itemsByFile).toEqual([["ALPHA"], ["BETA"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changed-reread: a size/mtime change re-parses just that file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-fcache-"));
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      await writeFile(a, "alpha");
      await writeFile(b, "beta");
      const cachePath = join(dir, "cache.json");
      const parse = (content: string) => [content.toUpperCase()];
      await readFilesWithCache({ files: [a, b], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      await writeFile(b, "beta-appended");
      const second = await readFilesWithCache({ files: [a, b], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      expect(second.filesRead).toBe(1);
      expect(second.itemsByFile).toEqual([["ALPHA"], ["BETA-APPENDED"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deleted-pruned: a removed file's items drop out and its cache entry is pruned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-fcache-"));
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      await writeFile(a, "alpha");
      await writeFile(b, "beta");
      const cachePath = join(dir, "cache.json");
      const parse = (content: string) => [content.toUpperCase()];
      await readFilesWithCache({ files: [a, b], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      await rm(b);
      const second = await readFilesWithCache({ files: [a], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      expect(second.itemsByFile).toEqual([["ALPHA"]]);
      const persisted = JSON.parse(await readFile(cachePath, "utf8")) as { files: Record<string, unknown> };
      expect(Object.keys(persisted.files)).toEqual([a]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("timeout-persists-progress: a timed-out pass saves what it parsed; the next pass completes without re-reading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-fcache-"));
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      await writeFile(a, "alpha");
      await writeFile(b, "beta");
      const cachePath = join(dir, "cache.json");
      const parse = (content: string) => [content.toUpperCase()];
      // Clock that expires right after the first read: first call to now() is
      // the deadline base... deadline passed explicitly, so make now() jump
      // past the deadline once one file has been parsed.
      let reads = 0;
      const timedOut = await readFilesWithCache({
        files: [a, b],
        cachePath,
        version: 1,
        parseFile: (c: string) => {
          reads += 1;
          return parse(c);
        },
        deadline: 1, // already expired for every check AFTER a cache-miss stat
        now: () => (reads === 0 ? 0 : 2), // first miss reads; second miss times out
      });
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.itemsByFile).toBeNull();
      expect(timedOut.filesRead).toBe(1);
      // Progress persisted: the completed file is cached, so the follow-up pass
      // only reads the remaining one.
      const second = await readFilesWithCache({ files: [a, b], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      expect(second.filesRead).toBe(1);
      expect(second.itemsByFile).toEqual([["ALPHA"], ["BETA"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("corrupt-cache-recovers: garbage cache JSON is ignored and rebuilt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-fcache-"));
    try {
      const a = join(dir, "a.txt");
      await writeFile(a, "alpha");
      const cachePath = join(dir, "cache.json");
      await writeFile(cachePath, "{not json!!!");
      const parse = (content: string) => [content.toUpperCase()];
      const res = await readFilesWithCache({ files: [a], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      expect(res.itemsByFile).toEqual([["ALPHA"]]);
      const again = await readFilesWithCache({ files: [a], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      expect(again.filesRead).toBe(0); // rebuilt cache now valid
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("version-bump invalidates: a different version re-parses everything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-fcache-"));
    try {
      const a = join(dir, "a.txt");
      await writeFile(a, "alpha");
      const cachePath = join(dir, "cache.json");
      const parse = (content: string) => [content.toUpperCase()];
      await readFilesWithCache({ files: [a], cachePath, version: 1, parseFile: parse, deadline: Date.now() + 5000 });
      const v2 = await readFilesWithCache({ files: [a], cachePath, version: 2, parseFile: parse, deadline: Date.now() + 5000 });
      expect(v2.filesRead).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("claude native reader through the cache", () => {
  it("cross-file-dedup: forked sessions (duplicate request ids across files) still dedup max-wins with a warm cache", async () => {
    const { dir, env, proj } = await makeClaudeCorpus();
    try {
      // Original session and its fork share (msgId, reqId); the fork carries the
      // FINAL (maximal) token value; a second distinct request lives in the fork.
      await writeFile(
        join(proj, "orig.jsonl"),
        claudeLine({ ts: "2026-06-10T12:00:00Z", reqId: "r1", msgId: "m1", output: 40 }) + "\n",
      );
      await writeFile(
        join(proj, "fork.jsonl"),
        claudeLine({ ts: "2026-06-10T12:00:00Z", reqId: "r1", msgId: "m1", output: 100 }) +
          "\n" +
          claudeLine({ ts: "2026-06-10T13:00:00Z", reqId: "r2", msgId: "m2", output: 7 }) +
          "\n",
      );
      const cold = await collectClaudeNative(env, { budgetMs: 5000 });
      expect(cold.found).toBe(true);
      expect(cold.entries).toHaveLength(1);
      expect(cold.entries[0].outputTokens).toBe(107); // 100 (max-wins) + 7, never 40+100+7
      expect(cold.entries[0].requestCount).toBe(2);
      // Second, fully-cached pass must agree exactly.
      const warm = await collectClaudeNative(env, { budgetMs: 5000 });
      expect(warm.filesScanned).toBe(0); // nothing re-read
      expect(warm.entries).toEqual(cold.entries);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("synthetic (id-less) lines never collide across files or across runs", async () => {
    const { dir, env, proj } = await makeClaudeCorpus();
    try {
      const idless = JSON.stringify({
        timestamp: "2026-06-10T12:00:00Z",
        message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 0, output_tokens: 5 } },
      });
      await writeFile(join(proj, "one.jsonl"), idless + "\n");
      await writeFile(join(proj, "two.jsonl"), idless + "\n");
      const cold = await collectClaudeNative(env, { budgetMs: 5000 });
      expect(cold.entries[0].outputTokens).toBe(10); // both counted, never merged
      // A fresh process would restart the synthetic counter — the cache must
      // still keep the two files' synthetic requests distinct. Simulate by
      // re-running fully cached: add a third id-less file, so the run mixes
      // cached synthetic rows with freshly-parsed ones.
      await writeFile(join(proj, "three.jsonl"), idless + "\n");
      const mixed = await collectClaudeNative(env, { budgetMs: 5000 });
      expect(mixed.entries[0].outputTokens).toBe(15);
      expect(mixed.filesScanned).toBe(1); // only the new file was read
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an appended transcript is re-read and the day's total updates", async () => {
    const { dir, env, proj } = await makeClaudeCorpus();
    try {
      const f = join(proj, "s.jsonl");
      await writeFile(f, claudeLine({ ts: "2026-06-10T12:00:00Z", reqId: "r1", msgId: "m1", output: 10 }) + "\n");
      const first = await collectClaudeNative(env, { budgetMs: 5000 });
      expect(first.entries[0].outputTokens).toBe(10);
      await backdate(f, 120); // make the append visibly change mtime even on coarse clocks
      await writeFile(
        f,
        claudeLine({ ts: "2026-06-10T12:00:00Z", reqId: "r1", msgId: "m1", output: 10 }) +
          "\n" +
          claudeLine({ ts: "2026-06-10T18:00:00Z", reqId: "r2", msgId: "m2", output: 25 }) +
          "\n",
      );
      const second = await collectClaudeNative(env, { budgetMs: 5000 });
      expect(second.filesScanned).toBe(1);
      expect(second.entries[0].outputTokens).toBe(35);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("codex native reader through the cache", () => {
  it("codex: cached second pass reads nothing and produces identical entries (incl. multi-day cumulative differencing)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-codexcache-"));
    try {
      const sessions = join(dir, "sessions", "2026", "06", "10");
      await mkdir(sessions, { recursive: true });
      // Cumulative 100 → 300 across two days: day1=100, day2=200.
      await writeFile(
        join(sessions, "rollout-1.jsonl"),
        // 48h apart so the two events land on different LOCAL days in any
        // timezone the test machine runs in (dates come from localDate()).
        codexRollout("gpt-5.3-codex", [
          { ts: "2026-06-10T12:00:00Z", input: 60, output: 40 },
          { ts: "2026-06-12T12:00:00Z", input: 200, output: 100 },
        ]),
      );
      const env = { CODEX_HOME: dir, WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      const cold = await collectCodexNative(env, { budgetMs: 5000 });
      expect(cold.found).toBe(true);
      expect(cold.entries).toHaveLength(2);
      const total = cold.entries.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0);
      expect(total).toBe(300);
      const warm = await collectCodexNative(env, { budgetMs: 5000 });
      expect(warm.filesScanned).toBe(0);
      expect(warm.entries.sort((a, b) => (a.date < b.date ? -1 : 1))).toEqual(
        cold.entries.sort((a, b) => (a.date < b.date ? -1 : 1)),
      );
      // Cache file landed in the config dir under the expected name.
      const cachePath = nativeCachePath("codex", env);
      const persisted = JSON.parse(await readFile(cachePath, "utf8")) as { v: number };
      expect(persisted.v).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("codex: expired budget with a cold cache abandons (found:false) and persists progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wbm-codexcache-"));
    try {
      const sessions = join(dir, "sessions", "2026", "06", "10");
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, "rollout-1.jsonl"),
        codexRollout("gpt-5.3-codex", [{ ts: "2026-06-10T20:00:00Z", input: 10, output: 5 }]),
      );
      const env = { CODEX_HOME: dir, WHOBURNEDMORE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      const out = await collectCodexNative(env, { budgetMs: -1 });
      expect(out.found).toBe(false);
      expect(out.timedOut).toBe(true);
      expect(out.entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
