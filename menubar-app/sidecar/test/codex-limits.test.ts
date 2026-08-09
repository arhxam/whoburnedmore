import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { newestSessionFiles, parseCodexLimitLines, readCodexLimits } from "../src/codex-limits.js";

const POPULATED = JSON.stringify({
  timestamp: "2026-08-02T10:00:00.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {
      limit_id: "codex",
      plan_type: "plus",
      primary: { used_percent: 62.5, window_minutes: 300, resets_in_seconds: 3600 },
      secondary: { used_percent: 21, window_minutes: 10080, resets_at: "2026-08-08T00:00:00Z" },
      credits: { has_credits: true, unlimited: false, balance: "12.50" },
    },
  },
});

const SPARSE = JSON.stringify({
  timestamp: "2026-08-02T11:00:00.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {
      limit_id: "premium",
      limit_name: null,
      primary: null,
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: null },
      individual_limit: null,
      plan_type: "go",
      rate_limit_reached_type: null,
    },
  },
});

describe("codex-limits parsing", () => {
  it("codex-limits: parses populated windows with relative and absolute resets", () => {
    const l = parseCodexLimitLines([POPULATED]);
    expect(l.present).toBe(true);
    expect(l.planType).toBe("plus");
    expect(l.primary?.usedPercent).toBe(62.5);
    expect(l.primary?.windowMinutes).toBe(300);
    expect(l.primary?.resetsAt).toBe("2026-08-02T11:00:00.000Z"); // ts + 3600s
    expect(l.secondary?.usedPercent).toBe(21);
    expect(l.secondary?.resetsAt).toBe("2026-08-08T00:00:00Z");
    expect(l.hasCredits).toBe(true);
    expect(l.creditsBalance).toBe("12.50");
  });

  it("codex-limits: parses the sparse null-window shape without inventing data", () => {
    const l = parseCodexLimitLines([SPARSE]);
    expect(l.present).toBe(true);
    expect(l.planType).toBe("go");
    expect(l.limitId).toBe("premium");
    expect(l.primary).toBeNull();
    expect(l.secondary).toBeNull();
    expect(l.hasCredits).toBe(false);
  });

  it("codex-limits: accepts Unix-second resets_at values emitted by current Codex", () => {
    const l = parseCodexLimitLines([
      JSON.stringify({
        timestamp: "2026-08-09T15:22:42.136Z",
        payload: {
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            primary: { used_percent: 1, window_minutes: 10080, resets_at: 1_786_833_092 },
            secondary: null,
          },
        },
      }),
    ]);

    // A lone 10,080-minute window is weekly even when Codex puts it in
    // `primary`; do not mislabel it as a five-hour session window.
    expect(l.primary).toBeNull();
    expect(l.secondary?.label).toBe("weekly");
    expect(l.secondary?.usedPercent).toBe(1);
    expect(l.secondary?.resetsAt).toBe("2026-08-15T22:31:32.000Z");
  });

  it("codex-limits: keeps usage when a provider sends an out-of-range reset timestamp", () => {
    const l = parseCodexLimitLines([
      JSON.stringify({
        timestamp: "2026-08-09T15:22:42.136Z",
        payload: {
          rate_limits: {
            primary: {
              used_percent: 100,
              window_minutes: 10080,
              resets_at: Number.MAX_VALUE,
            },
          },
        },
      }),
    ]);
    expect(l.present).toBe(true);
    expect(l.secondary?.usedPercent).toBe(100);
    expect(l.secondary?.resetsAt).toBeNull();
  });

  it("codex-limits: last event wins and malformed/blank lines are skipped", () => {
    const l = parseCodexLimitLines([
      "",
      "not json {{{",
      POPULATED,
      '{"rate_limits": "string-not-object"}',
      SPARSE,
    ]);
    expect(l.planType).toBe("go"); // SPARSE came last
  });

  it("codex-limits: empty input and missing dirs return absent", () => {
    expect(parseCodexLimitLines([]).present).toBe(false);
    expect(readCodexLimits({ CODEX_HOME: "/nonexistent-path-bb" } as NodeJS.ProcessEnv).present).toBe(false);
  });

  it("codex-limits: readCodexLimits finds the newest session file in a real tree", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-codex-"));
    const dayDir = join(root, "sessions", "2026", "08", "02");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, "rollout-old.jsonl"),
      SPARSE.replace("2026-08-02T11:00:00.000Z", "2026-08-02T09:00:00.000Z") + "\n",
    );
    const newFile = join(dayDir, "rollout-new.jsonl");
    writeFileSync(newFile, POPULATED + "\n");
    // Bump mtime so "new" is genuinely newest.
    const future = new Date(Date.now() + 5000);
    utimesSync(newFile, future, future);
    const l = readCodexLimits({ CODEX_HOME: root } as NodeJS.ProcessEnv);
    expect(l.planType).toBe("plus");
    expect(newestSessionFiles(join(root, "sessions"))[0]).toBe(newFile);
  });

  it("codex-limits: newest rate-limit event wins across concurrent session files", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-codex-concurrent-"));
    const dayDir = join(root, "sessions", "2026", "08", "09");
    mkdirSync(dayDir, { recursive: true });

    const staleFile = join(dayDir, "rollout-stale-but-recently-touched.jsonl");
    const freshFile = join(dayDir, "rollout-fresh-event.jsonl");
    writeFileSync(staleFile, POPULATED + "\n");
    writeFileSync(
      freshFile,
      POPULATED.replace("2026-08-02T10:00:00.000Z", "2026-08-09T15:00:00.000Z")
        .replace('"used_percent":62.5', '"used_percent":100') + "\n",
    );

    // Files can be touched out of event order by several live Codex instances.
    // File mtime must only bound the search, never decide the winning reading.
    const touchedLater = new Date("2026-08-09T16:00:00.000Z");
    utimesSync(staleFile, touchedLater, touchedLater);

    const l = readCodexLimits(
      { CODEX_HOME: root } as NodeJS.ProcessEnv,
      new Date("2026-08-09T15:01:00.000Z").getTime(),
    );
    expect(l.capturedAt).toBe("2026-08-09T15:00:00.000Z");
    expect(l.primary?.usedPercent).toBe(100);
  });

  it("codex-limits: clears an exhausted window immediately after its reset boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-codex-reset-"));
    const dayDir = join(root, "sessions", "2026", "08", "09");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, "rollout-reset.jsonl"),
      JSON.stringify({
        timestamp: "2026-08-09T14:59:00.000Z",
        payload: {
          rate_limits: {
            primary: {
              used_percent: 100,
              window_minutes: 10080,
              resets_at: "2026-08-09T15:00:00.000Z",
            },
          },
        },
      }) + "\n",
    );

    const l = readCodexLimits(
      { CODEX_HOME: root } as NodeJS.ProcessEnv,
      new Date("2026-08-09T15:00:01.000Z").getTime(),
    );
    expect(l.secondary?.usedPercent).toBe(0);
    expect(l.secondary?.resetsAt).toBeNull();
  });
});
