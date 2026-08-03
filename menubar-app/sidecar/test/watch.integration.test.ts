/**
 * Real-time proof (rubric item 6): spawn the ACTUAL compiled sidecar binary
 * against temp fixture dirs, append a Claude transcript line, and require an
 * updated snapshot event on stdout within 5 seconds of the append.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseEvent, type Event, type Summary } from "../src/protocol.js";

const BIN = join(__dirname, "..", "dist", "burnbar-sidecar");

function claudeLine(requestId: string, tokens: number): string {
  return (
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      message: {
        id: `msg_${requestId}`,
        model: "claude-fable-5",
        usage: { input_tokens: tokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }) + "\n"
  );
}

describe("watch mode real-time integration", () => {
  let root: string;
  let child: ChildProcess | null = null;

  beforeAll(() => {
    if (!existsSync(BIN)) {
      execFileSync("bun", ["build", "--compile", "--outfile", BIN, join(__dirname, "..", "src", "main.ts")], {
        stdio: "ignore",
        timeout: 120_000,
      });
    }
    root = mkdtempSync(join(tmpdir(), "bb-watch-"));
    mkdirSync(join(root, "claude", "projects", "proj"), { recursive: true });
    mkdirSync(join(root, "codex", "sessions", "2026", "08", "02"), { recursive: true });
    writeFileSync(
      join(root, "claude", "projects", "proj", "session-a.jsonl"),
      claudeLine("req_initial", 1000),
    );
  });

  afterAll(() => {
    child?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  });

  it("emits an updated snapshot within 5s of a transcript append", { timeout: 60_000 }, async () => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      BURNBAR_CACHE_DIR: join(root, "cache"),
      BURNBAR_CCUSAGE: "", // no long tail in the fixture world
      BURNBAR_DEBOUNCE_MS: "300",
      HOME: root, // keep vscode/continue readers away from the real machine
    };
    child = spawn(BIN, ["watch"], { env, stdio: ["pipe", "pipe", "pipe"] });

    const snapshots: Summary[] = [];
    let buffer = "";
    const events: Event[] = [];
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const ev = parseEvent(line);
        if (!ev) continue;
        events.push(ev);
        if (ev.type === "snapshot") snapshots.push(ev.summary);
      }
    });

    // Wait for the initial snapshot (cold collect of the 1000-token fixture).
    await waitFor(() => snapshots.length >= 1, 30_000, "initial snapshot");
    expect(snapshots[0].today.totalTokens).toBe(1010);

    // THE real-time claim: append -> updated snapshot within 5s.
    const appendedAt = Date.now();
    appendFileSync(
      join(root, "claude", "projects", "proj", "session-a.jsonl"),
      claudeLine("req_live", 5000),
    );
    await waitFor(
      () => snapshots.some((s) => s.today.totalTokens === 1010 + 5010),
      5_000,
      "updated snapshot within 5s",
    );
    const elapsed = Date.now() - appendedAt;
    expect(elapsed).toBeLessThan(5_000);

    expect(events.some((e) => e.type === "hello")).toBe(true);
    expect(events.some((e) => e.type === "limits")).toBe(true);
  });
});

function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error(`timeout waiting for ${what}`));
      }
    }, 50);
  });
}
