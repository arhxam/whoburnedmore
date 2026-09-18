import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transcriptFingerprint } from "../src/transcript-fingerprint.js";

describe("Codex transcript metadata fingerprint", () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reuses unchanged transcripts and invalidates appends, archives, deletions and same-size rewrites", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-fingerprint-"));
    temporary.push(root);
    const active = join(root, "sessions");
    const archived = join(root, "archived_sessions");
    const roots = [active, archived];
    const missing = await transcriptFingerprint(roots);
    await mkdir(active);
    await mkdir(archived);
    const file = join(active, "rollout.jsonl");
    await writeFile(file, "first");
    const initial = await transcriptFingerprint(roots);
    expect(initial).not.toBe(missing);
    expect(await transcriptFingerprint(roots)).toBe(initial);
    await writeFile(file, "other");
    const rewritten = await transcriptFingerprint(roots);
    expect(rewritten).not.toBe(initial);
    await appendFile(file, "append");
    const appended = await transcriptFingerprint(roots);
    expect(appended).not.toBe(rewritten);
    await rename(file, join(archived, "rollout.jsonl"));
    const moved = await transcriptFingerprint(roots);
    expect(moved).not.toBe(appended);
    await rm(join(archived, "rollout.jsonl"));
    expect(await transcriptFingerprint(roots)).not.toBe(moved);
  });
});
