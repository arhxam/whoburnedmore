/**
 * Real-time proof (rubric item 6): spawn the ACTUAL compiled sidecar binary
 * against temp fixture dirs, append a Claude transcript line, and require an
 * updated snapshot event on stdout within 5 seconds of the append.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
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

function codexLines(tokens: number): string {
  const timestamp = new Date().toISOString();
  return [
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: { id: "live-session", model: "gpt-5-codex", model_provider: "openai" },
    }),
    codexTokenLine(tokens, timestamp).trimEnd(),
  ].join("\n") + "\n";
}

function codexTokenLine(tokens: number, timestamp = new Date().toISOString()): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: tokens,
          cached_input_tokens: 0,
          output_tokens: 10,
        },
      },
    },
  }) + "\n";
}

function codexRateLimitLine(percent: number, resetsAt: number): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: percent, window_minutes: 10080, resets_at: resetsAt },
        secondary: null,
      },
    },
  }) + "\n";
}

describe("watch mode real-time integration", () => {
  let root: string;
  let child: ChildProcess | null = null;

  beforeAll(() => {
    execFileSync("bun", ["build", "--compile", "--outfile", BIN, join(__dirname, "..", "src", "main.ts")], {
      stdio: "ignore",
      timeout: 120_000,
    });
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

  it("starts live-counting Codex when its sessions directory is created after launch", { timeout: 60_000 }, async () => {
    child?.kill("SIGTERM");
    const lateRoot = mkdtempSync(join(tmpdir(), "bb-watch-late-codex-"));
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(lateRoot, "missing-claude"),
      CODEX_HOME: join(lateRoot, "codex"),
      BURNBAR_CACHE_DIR: join(lateRoot, "cache"),
      BURNBAR_CCUSAGE: "",
      BURNBAR_DEBOUNCE_MS: "100",
      BURNBAR_SLOW_INTERVAL_MS: "600000",
      BURNBAR_WATCH_RESCAN_MS: "600000",
      BURNBAR_NATIVE_POLL_MS: "100",
      HOME: lateRoot,
    };
    child = spawn(BIN, ["watch"], { env, stdio: ["pipe", "pipe", "pipe"] });

    const snapshots: Summary[] = [];
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const ev = parseEvent(line);
        if (ev?.type === "snapshot") snapshots.push(ev.summary);
      }
    });

    await waitFor(() => snapshots.length >= 1, 30_000, "empty initial snapshot");
    expect(snapshots[0].today.totalTokens).toBe(0);

    const liveDir = join(lateRoot, "codex", "sessions", "2026", "08", "08");
    mkdirSync(liveDir, { recursive: true });
    const liveFile = join(liveDir, "rollout-live.jsonl");
    writeFileSync(liveFile, codexLines(7000));

    await waitFor(
      () => snapshots.some((s) => s.today.totalTokens === 7010),
      3_000,
      "new live Codex session snapshot",
    );

    // The rollout remains in the active sessions tree. A later cumulative
    // usage event must replace the live total without waiting for a message to
    // finish or for Codex to move the file into archived_sessions.
    appendFileSync(liveFile, codexTokenLine(9000));
    await waitFor(
      () => snapshots.some((s) => s.today.totalTokens === 9010),
      3_000,
      "updated active Codex rollout snapshot",
    );
    rmSync(lateRoot, { recursive: true, force: true });
  });

  it("emits Codex limit changes without waiting for the token collector", { timeout: 60_000 }, async () => {
    child?.kill("SIGTERM");
    const limitRoot = mkdtempSync(join(tmpdir(), "bb-watch-live-limits-"));
    const liveDir = join(limitRoot, "codex", "sessions", "2026", "08", "09");
    mkdirSync(liveDir, { recursive: true });
    const liveFile = join(liveDir, "rollout-live-limits.jsonl");
    const futureReset = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    writeFileSync(liveFile, codexLines(7000) + codexRateLimitLine(99, futureReset));

    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(limitRoot, "missing-claude"),
      CODEX_HOME: join(limitRoot, "codex"),
      BURNBAR_CACHE_DIR: join(limitRoot, "cache"),
      BURNBAR_CCUSAGE: "",
      // Disable every existing collection trigger. Only the dedicated limits
      // poll is allowed to observe the appended 100% event.
      BURNBAR_DEBOUNCE_MS: "600000",
      BURNBAR_SLOW_INTERVAL_MS: "600000",
      BURNBAR_WATCH_RESCAN_MS: "600000",
      BURNBAR_NATIVE_POLL_MS: "600000",
      BURNBAR_LIMITS_POLL_MS: "100",
      HOME: limitRoot,
    };
    child = spawn(BIN, ["watch"], { env, stdio: ["pipe", "pipe", "pipe"] });

    const percents: number[] = [];
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const ev = parseEvent(line);
        if (ev?.type === "limits") {
          const percent = ev.limits.codex.secondary?.usedPercent;
          if (percent !== null && percent !== undefined) percents.push(percent);
        }
      }
    });

    await waitFor(() => percents.includes(99), 30_000, "initial Codex limit");
    const appendedAt = Date.now();
    appendFileSync(liveFile, codexRateLimitLine(100, futureReset));
    await waitFor(() => percents.includes(100), 2_000, "live Codex 100% limit");
    expect(Date.now() - appendedAt).toBeLessThan(2_000);

    child.kill("SIGTERM");
    rmSync(limitRoot, { recursive: true, force: true });
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
