import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectClaudeNative, collectClaudeRequests } from "../src/native/claude.js";
import { MAX_NATIVE_FILE_BYTES, nativeCachePath, readFilesWithCache } from "../src/native/file-cache.js";
import { readJsonlStream } from "../src/native/jsonl-stream.js";

function usage(id: string, output: number): string {
  return JSON.stringify({ timestamp: "2026-10-20T12:00:00Z", requestId: id,
    message: { id, role: "assistant", model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: output } } });
}
async function corpus() {
  const dir = await mkdtemp(join(tmpdir(), "wbm-large-"));
  const project = join(dir, "projects", "p");
  await mkdir(project, { recursive: true });
  return { dir, project, env: { CLAUDE_CONFIG_DIR: dir, WHOBURNEDMORE_CONFIG_DIR: dir } };
}

describe("large Claude transcripts", () => {
  it("counts a session after it crosses 64 MiB, retains fork dedup, and agrees with verify and warm cache", async () => {
    const { dir, project, env } = await corpus();
    try {
      const session = join(project, "session.jsonl");
      await writeFile(session, usage("request", 20) + "\n");
      expect((await collectClaudeNative(env)).entries[0]?.outputTokens).toBe(20);
      // Real transcripts grow mainly through tool output, not usage records.
      const tool = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(1024 * 1024) } }) + "\n";
      for (let i = 0; i < 65; i++) await appendFile(session, tool);
      await appendFile(session, usage("request", 50) + "\n" + usage("second", 100));
      await writeFile(join(project, "fork.jsonl"), usage("request", 30));
      const cold = await collectClaudeNative(env);
      expect(cold.found).toBe(true);
      expect(cold.entries).toHaveLength(1);
      expect(cold.entries[0]).toMatchObject({ inputTokens: 20, outputTokens: 150, requestCount: 2 });
      const warm = await collectClaudeNative(env);
      expect(warm.entries).toEqual(cold.entries);
      expect(warm.filesScanned).toBe(0);
      const verified = await collectClaudeRequests(env);
      expect(verified.found).toBe(true);
      expect(verified.requests).toHaveLength(2);
      expect(verified.requests.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(150);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects excessive retained request data without persisting or returning a partial corpus", async () => {
    const { dir, project, env } = await corpus();
    try {
      const session = join(project, "session.jsonl");
      await writeFile(session, usage("first", 20) + "\n" + usage("second", 30));
      // One small usage record fits, but retaining both crosses this test budget.
      const result = await collectClaudeNative(env, { maxRequestBytes: 400 });
      expect(result).toMatchObject({ found: false, entries: [], timedOut: true });
      expect(JSON.parse(await readFile(nativeCachePath("claude", env), "utf8")).files[session]).toBeUndefined();
      expect(await collectClaudeRequests(env, { maxRequestBytes: 400 }))
        .toEqual({ found: false, requests: [], timedOut: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects partial totals and stale cached usage when a single record exceeds the memory bound", async () => {
    const { dir, project, env } = await corpus();
    try {
      const session = join(project, "session.jsonl");
      await writeFile(session, usage("request", 20) + "\n");
      await collectClaudeNative(env);
      await appendFile(session, "x".repeat(1025));
      const result = await collectClaudeNative(env, { maxLineBytes: 1024 });
      expect(result).toMatchObject({ found: false, entries: [], timedOut: true });
      const cached = JSON.parse(await readFile(nativeCachePath("claude", env), "utf8"));
      expect(cached.files[session]).toBeUndefined();
      const verify = await collectClaudeRequests(env, { maxFileBytes: 1024 });
      expect(verify).toEqual({ found: false, requests: [], timedOut: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("bounded JSONL streaming", () => {
  it("preserves UTF-8 across chunks, CRLF, empty lines, and an unterminated final line", async () => {
    const { dir, project } = await corpus();
    try {
      const path = join(project, "session.jsonl");
      const line = "x".repeat(64 * 1024 - 1) + "🔥";
      await writeFile(path, line + "\r\n\nlast");
      const lines: string[] = [];
      expect(await readJsonlStream(path, (s) => lines.push(s), { deadline: Infinity })).toEqual({ ok: true });
      expect(lines).toEqual([line + "\r", "", "last"]);
      expect(MAX_NATIVE_FILE_BYTES).toBe(64 * 1024 * 1024);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses symlinks and stops within a file when the deadline expires", async () => {
    const { dir, project } = await corpus();
    try {
      const path = join(project, "session.jsonl");
      const link = join(project, "link.jsonl");
      await writeFile(path, "first\nsecond\n");
      await symlink(path, link, "file");
      expect(await readJsonlStream(link, () => {}, { deadline: Infinity })).toEqual({ ok: false, reason: "unreadable" });
      let clock = 0;
      const lines: string[] = [];
      const result = await readJsonlStream(path, (s) => { lines.push(s); clock = 2; }, { deadline: 1, now: () => clock });
      expect(result).toEqual({ ok: false, reason: "timed-out" });
      expect(lines).toEqual(["first"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});


describe("streaming cache completeness", () => {
  it("rejects a vanished file and a symlink even if the target matches a warm cache row", async () => {
    const { dir, project } = await corpus();
    try {
      const path = join(project, "session.jsonl");
      const target = join(project, "original.jsonl");
      await writeFile(path, "usage");
      const options = { files: [path], cachePath: join(dir, "cache.json"), version: 1,
        parseFile: (s: string) => [s], streamFile: async (p: string) => ({ ok: true as const, items: [await readFile(p, "utf8")] }),
        deadline: Infinity };
      expect((await readFilesWithCache(options)).itemsByFile).toEqual([["usage"]]);
      // Renaming preserves size/mtime/inode, reproducing the stat-following cache bypass.
      const { rename } = await import("node:fs/promises");
      await rename(path, target);
      await symlink(target, path, "file");
      expect(await readFilesWithCache(options)).toMatchObject({ itemsByFile: null, incomplete: true });
      await rm(path);
      expect(await readFilesWithCache(options)).toMatchObject({ itemsByFile: null, incomplete: true });
      await writeFile(path, "usage");
      expect(await readFilesWithCache({ ...options, streamFile: async () => { throw new Error("read failed"); } }))
        .toMatchObject({ itemsByFile: null, incomplete: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
