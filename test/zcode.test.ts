import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectZcode,
  mapZcodeUsageRows,
  type ZcodeUsageRow,
} from "../src/zcode.js";

const sqliteAvailable = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const LOCAL_NOON = new Date(2026, 5, 10, 12, 0, 0).getTime();

function row(overrides: Partial<ZcodeUsageRow> = {}): ZcodeUsageRow {
  return {
    model_id: "GLM-5.3",
    input_tokens: 1000,
    output_tokens: 50,
    reasoning_tokens: 10,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
    started_at: LOCAL_NOON - 60_000,
    completed_at: LOCAL_NOON,
    ...overrides,
  };
}

describe("mapZcodeUsageRows", () => {
  it("splits cached tokens out of folded input and aggregates by day + model", () => {
    const entries = mapZcodeUsageRows([row(), row({ reasoning_tokens: 0, output_tokens: 25 })], LOCAL_NOON);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      date: "2026-06-10",
      tool: "zcode",
      model: "GLM-5.3",
      inputTokens: 1400,
      outputTokens: 75,
      cacheCreationTokens: 200,
      cacheReadTokens: 400,
      requestCount: 2,
    });
    expect(entries[0]!.costUSD).toBeGreaterThan(0);
  });

  it("dates by completed_at, falling back to started_at", () => {
    const completed = mapZcodeUsageRows([row()], LOCAL_NOON);
    expect(completed[0]?.date).toBe("2026-06-10");

    const nextDay = new Date(2026, 5, 11, 12, 0, 0).getTime();
    const started = mapZcodeUsageRows(
      [row({ completed_at: null, started_at: nextDay })],
      nextDay,
    );
    expect(started[0]?.date).toBe("2026-06-11");
  });

  it("skips rows with no usage or no model", () => {
    expect(
      mapZcodeUsageRows(
        [
          row({
            input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }),
          row({ model_id: "" }),
        ],
        LOCAL_NOON,
      ),
    ).toEqual([]);
  });
});

describe.skipIf(!sqliteAvailable)("collectZcode (SQLite)", () => {
  it("reads model_usage end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-zc-"));
    try {
      const dbPath = join(root, "db.sqlite");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`CREATE TABLE model_usage (
          id TEXT PRIMARY KEY,
          model_id TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          started_at INTEGER,
          completed_at INTEGER
        )`);
        const insert = db.prepare(`INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        insert.run(
          "u1",
          "GLM-5.3",
          1000,
          50,
          10,
          100,
          200,
          LOCAL_NOON - 60_000,
          LOCAL_NOON,
        );
        insert.run("u2", "GLM-5.3", 0, 0, 0, 0, 0, LOCAL_NOON, LOCAL_NOON);
      } finally {
        db.close();
      }

      const result = await collectZcode({ dbPath, now: () => LOCAL_NOON });
      expect(result).toMatchObject({ found: true, filesScanned: 1 });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        tool: "zcode",
        model: "GLM-5.3",
        inputTokens: 700,
        outputTokens: 50,
        cacheCreationTokens: 100,
        cacheReadTokens: 200,
        requestCount: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no-ops when the DB is absent", async () => {
    const result = await collectZcode({ dbPath: join(tmpdir(), "wbm-no-such-db.sqlite") });
    expect(result).toMatchObject({ found: false, entries: [] });
  });
});
