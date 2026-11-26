import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateDevinCloudSessions,
  collectDevinCloud,
  collectDevinCloudLocal,
  DEFAULT_DEVIN_ACU_USD,
  DEVIN_CLOUD_TOOL,
  extractDevinCloudModel,
  extractDevinCloudSessionId,
  fetchDevinAnalytics,
  fetchDevinV3Consumption,
  isDevinCloudMeta,
  mapDevinAnalyticsRows,
  mapDevinV3Consumption,
  parseDevinCloudPayloads,
  readDevinOrgId,
  resolveDevinAcuUsd,
} from "../src/devin-cloud.js";
import { DailyUsageEntry, SubmitPayload } from "../src/shared.js";

const DAY1_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY2_MS = Date.UTC(2026, 10, 21, 12, 0, 0);
const NOW = Date.UTC(2026, 10, 24);
const DAY1 = new Date(DAY1_MS).toLocaleDateString("en-CA");
const DAY2 = new Date(DAY2_MS).toLocaleDateString("en-CA");

function hasNodeSqlite(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function makeCursor(session: string): string {
  return Buffer.from(JSON.stringify({ version: 2, session })).toString("base64");
}

function makeCloudMeta(opts: {
  session?: string;
  model?: string;
  devinVersion?: string;
  orgId?: string;
} = {}): Record<string, string> {
  const configOptions: Array<{ id: string; currentValue: string }> = [
    { id: "org_id", currentValue: opts.orgId ?? "org-test123" },
  ];
  if (opts.model !== undefined) {
    configOptions.push({ id: "model", currentValue: opts.model });
  }
  if (opts.devinVersion !== undefined) {
    configOptions.push({ id: "devin_version", currentValue: opts.devinVersion });
  }
  const meta: Record<string, string> = {
    schema_version: "6",
    info: JSON.stringify({ configOptions }),
  };
  if (opts.session) {
    meta.source_history = JSON.stringify({
      version: 2,
      replayedTail: {
        start: { cursor: makeCursor(opts.session) },
        end: { cursor: makeCursor(opts.session) },
      },
    });
  }
  return meta;
}

function makeAcuPayload(ms: number, acuAmount: number): string {
  return JSON.stringify({
    kind: "tool_call",
    sourceEventType: "acu_consumption_at_last_user_interaction",
    sourceEventTimestampMs: ms,
    content: {
      toolCallId: `ev-${ms}`,
      _meta: {
        "cognition.ai/timestamp": new Date(ms).toISOString(),
        "cognition.ai/createdAtMs": ms,
        "cognition.ai/eventType": "acu_consumption_at_last_user_interaction",
        "cognition.ai/acuAmount": acuAmount,
      },
    },
  });
}

function makeDeltaPayload(ms: number, acuConsumption: number): string {
  return JSON.stringify({
    kind: "tool_call",
    sourceEventType: "shell_process_completed",
    sourceEventTimestampMs: ms,
    content: {
      _meta: {
        "cognition.ai/timestamp": new Date(ms).toISOString(),
        "cognition.ai/eventType": "shell_process_completed",
        "cognition.ai/acuConsumption": acuConsumption,
      },
    },
  });
}

describe("Devin Cloud metadata helpers", () => {
  it("distinguishes cloud session DBs from local CLI session DBs", () => {
    expect(isDevinCloudMeta(makeCloudMeta({ session: "devin-abc" }))).toBe(true);
    expect(isDevinCloudMeta({ info: JSON.stringify({ configOptions: [{ id: "org_id", currentValue: "org-1" }] }) })).toBe(true);
    expect(isDevinCloudMeta({ info: JSON.stringify({ configOptions: [{ id: "mode", currentValue: "accept-edits" }] }) })).toBe(false);
    expect(isDevinCloudMeta({})).toBe(false);
  });

  it("extracts session id from base64 source_history cursor", () => {
    expect(extractDevinCloudSessionId(makeCloudMeta({ session: "devin-deadbeef" }))).toBe("devin-deadbeef");
    expect(extractDevinCloudSessionId({ source_history: "{bad json" })).toBeNull();
    expect(extractDevinCloudSessionId({})).toBeNull();
  });

  it("extracts model or devin_version and ignores routing modes", () => {
    expect(extractDevinCloudModel(makeCloudMeta({ devinVersion: "devin-2-5" }))).toBe("devin-2-5");
    expect(extractDevinCloudModel(makeCloudMeta({ model: "swe-2-1-medium", devinVersion: "devin-2-5" }))).toBe("swe-2-1-medium");
    expect(extractDevinCloudModel(makeCloudMeta({ model: "adaptive" }))).toBe(DEVIN_CLOUD_TOOL);
    expect(extractDevinCloudModel(makeCloudMeta({ devinVersion: "fusion-claude-opus" }))).toBe(DEVIN_CLOUD_TOOL);
    expect(extractDevinCloudModel({})).toBe(DEVIN_CLOUD_TOOL);
  });

  it("resolves WHOBURNEDMORE_DEVIN_ACU_USD with safe bounds", () => {
    expect(resolveDevinAcuUsd({})).toBe(DEFAULT_DEVIN_ACU_USD);
    expect(resolveDevinAcuUsd({ WHOBURNEDMORE_DEVIN_ACU_USD: "2.25" })).toBe(2.25);
    expect(resolveDevinAcuUsd({ WHOBURNEDMORE_DEVIN_ACU_USD: "-5" })).toBe(DEFAULT_DEVIN_ACU_USD);
    expect(resolveDevinAcuUsd({ WHOBURNEDMORE_DEVIN_ACU_USD: "not-a-number" })).toBe(DEFAULT_DEVIN_ACU_USD);
  });
});

describe("parseDevinCloudPayloads & aggregateDevinCloudSessions", () => {
  it("computes monotonic cumulative ACU deltas across repeated & out-of-order replay events", () => {
    const meta = makeCloudMeta({ session: "devin-s1", devinVersion: "devin-swe21-lightning-medium" });
    const payloads = [
      makeAcuPayload(DAY1_MS + 1000, 0.05),
      makeAcuPayload(DAY1_MS + 2000, 0.08),
      makeAcuPayload(DAY1_MS + 3000, 0.08), // repeated snapshot: 0 delta
      makeAcuPayload(DAY1_MS + 1500, 0.08), // out-of-order replay row: must not double count
      makeAcuPayload(DAY2_MS + 1000, 0.20), // next day increment: +0.12 ACU
    ];
    const parsed = parseDevinCloudPayloads(meta, payloads, "fallback.db", NOW);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionKey).toBe("devin-s1");
    expect(parsed!.model).toBe("devin-swe21-lightning-medium");
    expect(parsed!.acusByDate.get(DAY1)).toBeCloseTo(0.08, 6);
    expect(parsed!.acusByDate.get(DAY2)).toBeCloseTo(0.12, 6);
    expect(parsed!.totalAcus).toBeCloseTo(0.20, 6);
  });

  it("falls back to positive acuConsumption deltas only when no cumulative acuAmount is present", () => {
    const meta = makeCloudMeta({ session: "devin-s2", devinVersion: "devin-2-5" });
    const parsed = parseDevinCloudPayloads(
      meta,
      [makeDeltaPayload(DAY1_MS, 0.03), makeDeltaPayload(DAY1_MS + 1000, 0.02)],
      "s2.db",
      NOW,
    );
    expect(parsed!.acusByDate.get(DAY1)).toBeCloseTo(0.05, 6);
  });

  it("deduplicates duplicate caches for the same session and produces schema-valid entries", () => {
    const meta = makeCloudMeta({ session: "devin-dup", devinVersion: "devin-2-5" });
    const older = parseDevinCloudPayloads(meta, [makeAcuPayload(DAY1_MS, 0.1)], "a.db", NOW)!;
    const newer = parseDevinCloudPayloads(meta, [makeAcuPayload(DAY1_MS, 0.25)], "b.db", NOW)!;
    const other = parseDevinCloudPayloads(
      makeCloudMeta({ session: "devin-other", devinVersion: "devin-2-5" }),
      [makeAcuPayload(DAY1_MS, 0.5)],
      "c.db",
      NOW,
    )!;

    const entries = aggregateDevinCloudSessions([older, newer, other], 2.0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      date: DAY1,
      tool: DEVIN_CLOUD_TOOL,
      model: "devin-2-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 1.5, // (0.25 + 0.5) * $2.00
      origin: "cli",
      verified: false,
    });
    expect(() => DailyUsageEntry.parse(entries[0])).not.toThrow();
    expect(() => SubmitPayload.parse({ cliVersion: "0.9.28", entries })).not.toThrow();
  });

  it("skips local (non-cloud) metadata and drops implausible future timestamps", () => {
    expect(parseDevinCloudPayloads({}, [makeAcuPayload(DAY1_MS, 0.1)], "local.db", NOW)).toBeNull();
    const future = Date.UTC(2099, 0, 1);
    const parsed = parseDevinCloudPayloads(
      makeCloudMeta({ session: "devin-future" }),
      [makeAcuPayload(future, 1.0)],
      "f.db",
      NOW,
    );
    expect(parsed!.totalAcus).toBe(0);
    expect(aggregateDevinCloudSessions([parsed!], 2.0)).toEqual([]);
  });
});

describe("SQLite acp-messages local collector", () => {
  it("never executes a PATH-shadowed sqlite3 binary", () => {
    const root = mkdtempSync(join(tmpdir(), "wbm-devin-sqlite-path-"));
    const marker = join(root, "executed");
    const fake = join(root, "sqlite3");
    const acpDir = join(root, "acp-messages");
    mkdirSync(acpDir, { recursive: true });
    writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    writeFileSync(join(acpDir, "corrupt.db"), "not sqlite");
    chmodSync(fake, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    try {
      const res = collectDevinCloudLocal({ acpMessagesDirs: [acpDir], now: NOW });
      expect(res).toEqual({ entries: [], found: false });
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasNodeSqlite())(
    "reads real SQLite acp-messages cloud DBs while skipping local CLI DBs",
    () => {
      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req("node:sqlite") as typeof import("node:sqlite");
      const root = mkdtempSync(join(tmpdir(), "wbm-devin-acp-"));
      try {
        const acpDir = join(root, "acp-messages");
        mkdirSync(acpDir, { recursive: true });

        // Cloud session DB
        const cloudDb = new DatabaseSync(join(acpDir, "cloud.db"));
        cloudDb.exec(
          "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE messages (position INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);",
        );
        const cloudMeta = makeCloudMeta({ session: "devin-111", devinVersion: "devin-2-5" });
        const insMeta = cloudDb.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
        for (const [k, v] of Object.entries(cloudMeta)) insMeta.run(k, v);
        const insMsg = cloudDb.prepare("INSERT INTO messages (position, kind, payload) VALUES (?, ?, ?)");
        insMsg.run(1, "tool_call", makeAcuPayload(DAY1_MS, 0.1));
        insMsg.run(2, "tool_call", makeAcuPayload(DAY1_MS + 60_000, 0.25));
        cloudDb.close();

        // Local CLI session DB cached in Desktop (must be ignored)
        const localDb = new DatabaseSync(join(acpDir, "local.db"));
        localDb.exec(
          "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE messages (position INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);",
        );
        localDb.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
          "info",
          JSON.stringify({ configOptions: [{ id: "mode", currentValue: "accept-edits" }] }),
        );
        localDb.prepare("INSERT INTO messages (position, kind, payload) VALUES (?, ?, ?)").run(
          1,
          "tool_call",
          makeAcuPayload(DAY1_MS, 99),
        );
        localDb.close();

        const res = collectDevinCloudLocal({
          acpMessagesDirs: [acpDir],
          env: { WHOBURNEDMORE_DEVIN_ACU_USD: "2.0" },
          now: NOW,
        });
        expect(res.found).toBe(true);
        expect(res.entries).toEqual([
          {
            date: DAY1,
            tool: DEVIN_CLOUD_TOOL,
            model: "devin-2-5",
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUSD: 0.5,
            origin: "cli",
            verified: false,
          },
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("Devin Cloud opt-in API mappers & collectors", () => {
  it("maps Analytics v2alpha DOLLARS token rows and ACU rows", () => {
    const entries = mapDevinAnalyticsRows(
      [
        {
          timestamp: DAY1,
          model_uid: "claude-sonnet-4-5",
          tokens: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 2000,
            cache_write_tokens: 300,
          },
        },
        {
          timestamp: DAY1,
          model_uid: "devin-2-5",
          consumption: { billed_acus: 1.5 },
        },
        {
          timestamp: "2099-01-01",
          model_uid: "claude-sonnet-4-5",
          tokens: { input_tokens: 999 },
        },
      ],
      2.0,
      NOW,
    );
    expect(entries).toHaveLength(2);
    const tokRow = entries.find((e) => e.model === "claude-sonnet-4-5")!;
    expect(tokRow).toMatchObject({
      date: DAY1,
      tool: DEVIN_CLOUD_TOOL,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 300,
      cacheReadTokens: 2000,
    });
    expect(tokRow.costUSD).toBeGreaterThan(0);

    const acuRow = entries.find((e) => e.model === "devin-2-5")!;
    expect(acuRow).toMatchObject({
      date: DAY1,
      tool: DEVIN_CLOUD_TOOL,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 3.0,
    });
  });

  it("maps Enterprise v3 consumption rows using Devin product ACUs (excluding Cascade/Terminal)", () => {
    const entries = mapDevinV3Consumption(
      [
        {
          date: Math.floor(DAY1_MS / 1000),
          acus: 10,
          acus_by_product: { devin: 2.5, automation: 0.5, review: 0.25, cascade: 6, terminal: 0.75 },
        },
        {
          date: DAY2,
          acus: 1.5, // no acus_by_product -> fall back to total acus
        },
        {
          date: DAY2,
          acus: 5,
          acus_by_product: { devin: 0, cascade: 5, terminal: 0 }, // cascade-only -> 0 Devin Cloud ACUs
        },
      ],
      2.0,
      NOW,
    );
    const byDate = Object.fromEntries(entries.map((e) => [e.date, e]));
    expect(byDate[DAY1]?.costUSD).toBeCloseTo(6.5, 6); // (2.5 + 0.5 + 0.25) * 2
    expect(byDate[DAY2]?.costUSD).toBeCloseTo(3.0, 6); // 1.5 * 2 (cascade-only ignored)
  });

  it("paginates fetchDevinAnalytics and rejects mid-pagination errors or page-cap truncation", async () => {
    const okFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ timestamp: DAY1, model_uid: "m", consumption: { billed_acus: 1 } }],
            pagination: { next_page_cursor: "cur-2" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ timestamp: DAY2, model_uid: "m", consumption: { billed_acus: 2 } }],
            pagination: { next_page_cursor: null },
          }),
          { status: 200 },
        ),
      );
    const rows = await fetchDevinAnalytics("key", { now: NOW, fetchImpl: okFetch });
    expect(rows).toHaveLength(2);
    expect(okFetch).toHaveBeenCalledTimes(2);

    const errFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{}], pagination: { next_page_cursor: "cur-2" } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 429 }));
    await expect(fetchDevinAnalytics("key", { now: NOW, fetchImpl: errFetch })).rejects.toThrow(
      /HTTP 429/,
    );

    const capFetch = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ data: [{}], pagination: { next_page_cursor: "always-more" } }),
          { status: 200 },
        ),
    );
    await expect(
      fetchDevinAnalytics("key", { now: NOW, maxPages: 2, fetchImpl: capFetch }),
    ).rejects.toThrow(/exceeded page cap/);
  });

  it("reads devin.org_id from config.json when DEVIN_ORG_ID is unset", () => {
    const root = mkdtempSync(join(tmpdir(), "wbm-devin-cfg-"));
    try {
      mkdirSync(join(root, "devin"), { recursive: true });
      writeFileSync(
        join(root, "devin", "config.json"),
        JSON.stringify({ devin: { org_id: "org-from-file" } }),
      );
      expect(readDevinOrgId({ HOME: root, XDG_CONFIG_HOME: root })).toBe("org-from-file");
      expect(
        readDevinOrgId({ HOME: root, XDG_CONFIG_HOME: root, DEVIN_ORG_ID: "org-explicit" }),
      ).toBe("org-explicit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects offline mode and WHOBURNEDMORE_DEVIN_CLOUD=0", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const offline = await collectDevinCloud({
      offline: true,
      acpMessagesDirs: [join(tmpdir(), "no-such-acp-dir")],
      env: {
        DEVIN_ANALYTICS_SERVICE_KEY: "secret",
        DEVIN_API_KEY: "cog_secret",
        DEVIN_ORG_ID: "org-1",
      },
      fetchImpl: fetchMock,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(offline).toEqual({ entries: [], found: false });

    const disabled = await collectDevinCloud({
      env: { WHOBURNEDMORE_DEVIN_CLOUD: "0", DEVIN_ANALYTICS_SERVICE_KEY: "secret" },
      fetchImpl: fetchMock,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(disabled).toEqual({ entries: [], found: false });
  });

  it("uses opt-in v3 API when DEVIN_API_KEY is set and online", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          consumption_by_date: [{ date: DAY1, acus: 2.0, acus_by_product: { devin: 2.0 } }],
        }),
        { status: 200 },
      ),
    );
    const res = await collectDevinCloud({
      offline: false,
      acpMessagesDirs: [join(tmpdir(), "no-such-acp-dir")],
      env: { DEVIN_API_KEY: "cog_test", DEVIN_ORG_ID: "org-123" },
      now: NOW,
      fetchImpl: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.found).toBe(true);
    expect(res.entries[0]).toMatchObject({
      date: DAY1,
      tool: DEVIN_CLOUD_TOOL,
      costUSD: 4.0,
    });

    // Also verify fetchDevinV3Consumption throws on HTTP error
    const errFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 403 }));
    await expect(
      fetchDevinV3Consumption("cog_test", { orgId: "org-123", fetchImpl: errFetch }),
    ).rejects.toThrow(/HTTP 403/);
  });
});
