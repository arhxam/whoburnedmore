import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProvenanceStore, saveProvenanceStore } from "../src/provenance-store.js";

const agent = { messageCount: 0, subagentMessages: 0, subagentTokens: 0, totalTokens: 0, userMessageCount: 0 };
const entry = (tool: string, requestCount: number) => ({
  date: "2026-07-18", tool, model: "test-model", inputTokens: 0,
  outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0,
  costUSD: 0, origin: "cli", verified: false, requestCount,
});
type Message = { event: string; result?: { entries: ReturnType<typeof entry>[] } };

describe("provenance transactions across processes", () => {
  let dir: string;
  let storePath: string;
  let modulePath: string;
  let children: ChildProcess[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wbm-prov-race-"));
    storePath = join(dir, "provenance.json");
    modulePath = join(dir, "provenance.mjs");
    children = [];
    await build({
      entryPoints: [fileURLToPath(new URL("../src/provenance-store.ts", import.meta.url))],
      bundle: true, platform: "node", format: "esm", outfile: modulePath,
    });
    saveProvenanceStore(storePath, { v: 1, req: {} });
  });

  afterEach(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exit;
    }));
    await rm(dir, { recursive: true, force: true });
  });

  function writer(tool: string, requests: number, complete = true, pausePath?: string, reapBarrier?: string) {
    const child = fork(fileURLToPath(new URL("./fixtures/provenance-writer.mjs", import.meta.url)), [
      pathToFileURL(modulePath).href, storePath,
      JSON.stringify({ entries: [entry(tool, requests)], agent, complete, reapBarrier }), pausePath ?? "",
    ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.push(child);
    const messages: Message[] = [];
    child.on("message", (message) => messages.push(message as Message));
    const wait = (events: string[]) => new Promise<Message>((resolve, reject) => {
      const check = (message: Message) => {
        if (!events.includes(message.event)) return;
        cleanup(); resolve(message);
      };
      const fail = () => { cleanup(); reject(new Error(`writer exited before ${events.join("/")}`)); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`writer timed out: ${events.join("/")}`)); }, 10_000);
      const cleanup = () => { clearTimeout(timeout); child.off("message", check); child.off("exit", fail); };
      child.on("message", check); child.on("exit", fail);
      const prior = messages.find((message) => events.includes(message.event));
      if (prior) check(prior);
    });
    return { child, wait };
  }

  it("keeps both fingerprints when one writer is paused before its atomic save", async () => {
    const release = join(dir, "release");
    const first = writer("claude", 100, true, release);
    await first.wait(["saving"]);
    const second = writer("codex", 50);
    // Old code completes from the same stale store; fixed code contends on the
    // transaction lock. Either event establishes the overlap without sleeps.
    await second.wait(["contended", "done"]);
    await writeFile(release, "go");
    await Promise.all([first.wait(["done"]), second.wait(["done"])]);
    expect(loadProvenanceStore(storePath)?.req).toEqual({
      "2026-07-18|claude": 100, "2026-07-18|codex": 50,
    });
    expect(JSON.parse(await readFile(storePath, "utf8")).v).toBe(1);
  });

  it("restores a partial run from the preceding transaction, not a stale snapshot", async () => {
    saveProvenanceStore(storePath, { v: 1, req: { "2026-07-18|claude": 10 } });
    const release = join(dir, "release");
    const first = writer("claude", 100, true, release);
    await first.wait(["saving"]);
    const second = writer("claude", 20, false);
    await second.wait(["contended", "done"]);
    await writeFile(release, "go");
    const [, partial] = await Promise.all([first.wait(["done"]), second.wait(["done"])]);
    expect(partial.result?.entries[0].requestCount).toBe(100);
    expect(loadProvenanceStore(storePath)?.req["2026-07-18|claude"]).toBe(100);
    await writer("claude", 40).wait(["done"]);
    expect(loadProvenanceStore(storePath)?.req["2026-07-18|claude"]).toBe(40);
  });

  it("recovers after a writer dies holding the lock, without losing the next updates", async () => {
    const first = writer("claude", 100, true, join(dir, "never-release"));
    await first.wait(["saving"]);
    const exited = new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
    first.child.kill("SIGKILL");
    await exited;
    // The interrupted atomic replacement left the previous valid store intact.
    expect(loadProvenanceStore(storePath)?.req).toEqual({});
    await Promise.all([writer("claude", 40).wait(["done"]), writer("codex", 50).wait(["done"])]);
    expect(loadProvenanceStore(storePath)?.req).toEqual({
      "2026-07-18|claude": 40, "2026-07-18|codex": 50,
    });
  });

  it("does not let a late stale-lock reaper delete a new owner's lock", async () => {
    const dead = writer("claude", 100, true, join(dir, "never-release"));
    await dead.wait(["saving"]);
    const exited = new Promise<void>((resolve) => dead.child.once("exit", () => resolve()));
    dead.child.kill("SIGKILL");
    await exited;
    const releaseFirstReaper = join(dir, "reap-first");
    const releaseSecondReaper = join(dir, "reap-second");
    const releaseWrite = join(dir, "write-first");
    const first = writer("claude", 40, true, releaseWrite, releaseFirstReaper);
    await first.wait(["reaping"]);
    const second = writer("codex", 50, true, undefined, releaseSecondReaper);
    await second.wait(["reaping"]);
    await writeFile(releaseFirstReaper, "go");
    await first.wait(["saving"]); // The replacement lock is live and nonempty.
    const marker = await readdir(`${storePath}.lock`);
    await writeFile(releaseSecondReaper, "go");
    await second.wait(["reaped"]);
    expect(await readdir(`${storePath}.lock`)).toEqual(marker);
    await writeFile(releaseWrite, "go");
    await Promise.all([first.wait(["done"]), second.wait(["done"])]);
    expect(loadProvenanceStore(storePath)?.req).toEqual({
      "2026-07-18|claude": 40, "2026-07-18|codex": 50,
    });
  });

  it("times out on a live owner and returns last-good data without writing unlocked", async () => {
    saveProvenanceStore(storePath, { v: 1, req: { "2026-07-18|claude": 80 } });
    const release = join(dir, "release");
    const first = writer("codex", 50, true, release);
    await first.wait(["saving"]);
    const before = await readFile(storePath, "utf8");
    const start = performance.now();
    const partial = await writer("claude", 20, false).wait(["done"]);
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(partial.result?.entries[0].requestCount).toBe(80);
    expect(await readFile(storePath, "utf8")).toBe(before);
    await writeFile(release, "go");
    await first.wait(["done"]);
    expect(loadProvenanceStore(storePath)?.req).toEqual({
      "2026-07-18|claude": 80, "2026-07-18|codex": 50,
    });
  });

  it("recovers an empty lock left by an interrupted release", async () => {
    await mkdir(`${storePath}.lock`);
    await writer("claude", 40).wait(["done"]);
    expect(loadProvenanceStore(storePath)?.req).toEqual({ "2026-07-18|claude": 40 });
  });

  it("leaves malformed locks untouched and skips persistence", async () => {
    await mkdir(`${storePath}.lock`);
    await writeFile(join(`${storePath}.lock`, "not-an-owner"), "untouched");
    await writer("claude", 40).wait(["done"]);
    expect(loadProvenanceStore(storePath)?.req).toEqual({});
    expect(await readFile(join(`${storePath}.lock`, "not-an-owner"), "utf8")).toBe("untouched");
  });

  it("refuses a symlink lock without touching its target", async () => {
    const target = join(dir, "target");
    await mkdir(target);
    await writeFile(join(target, "keep"), "untouched");
    await symlink(target, `${storePath}.lock`, process.platform === "win32" ? "junction" : "dir");
    await writer("claude", 40).wait(["done"]);
    expect(loadProvenanceStore(storePath)?.req).toEqual({});
    expect(await readFile(join(target, "keep"), "utf8")).toBe("untouched");
  });
});
