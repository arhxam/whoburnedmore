import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravityNoticeLines,
  collectAntigravity,
  detectAntigravity,
  mapAntigravityUsageRows,
  parseAntigravityGenMetadata,
  type AntigravityGenMetadataRow,
  type AntigravityStepRow,
} from "../src/antigravity.js";

const sqliteAvailable = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

// Minimal protobuf writer for fixtures.
function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function fieldBytes(number: number, bytes: Uint8Array): number[] {
  return [...varint((number << 3) | 2), ...varint(bytes.length), ...bytes];
}

function fieldVarint(number: number, value: number | bigint): number[] {
  return [...varint(number << 3), ...varint(value)];
}

function bytes(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const LOCAL_NOON = new Date(2026, 5, 10, 12, 0, 0).getTime();

function timestamp(ms: number): Uint8Array {
  return bytes(fieldVarint(1, Math.floor(ms / 1000)));
}

function fixture(
  opts: {
    responseId?: string;
    withCreatedAt?: boolean;
    withTimestamp?: boolean;
    model?: string;
    placeholder?: string;
  } = {},
): { genRows: AntigravityGenMetadataRow[]; stepRows: AntigravityStepRow[] } {
  const usage = bytes(
    fieldVarint(2, 100),
    fieldVarint(3, 50),
    fieldVarint(4, 5),
    fieldVarint(5, 20),
    fieldVarint(9, 10),
    fieldVarint(10, 40),
    fieldBytes(11, text(opts.responseId ?? "resp-1")),
  );
  const chatParts: number[][] = [fieldBytes(4, usage)];
  if (opts.withCreatedAt !== false) {
    chatParts.push(fieldBytes(9, bytes(fieldBytes(4, timestamp(LOCAL_NOON)))));
  }
  if (opts.model) chatParts.push(fieldBytes(19, text(opts.model)));
  if (opts.placeholder) {
    chatParts.push(
      fieldBytes(
        20,
        bytes(
          fieldBytes(1, text("model_enum")),
          fieldBytes(2, text(opts.placeholder)),
        ),
      ),
    );
  }
  const chat = bytes(...chatParts);
  const root = bytes(
    fieldBytes(1, chat),
    fieldBytes(2, Uint8Array.from(varint(0))),
  );
  return {
    genRows: [{ idx: 0, data: root }],
    stepRows: [
      {
        idx: 0,
        metadata:
          opts.withTimestamp === false
            ? null
            : bytes(fieldBytes(1, timestamp(LOCAL_NOON))),
      },
    ],
  };
}

describe("detectAntigravity", () => {
  it("detects every Antigravity variant under HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "wbm-ag-"));
    try {
      const env = { HOME: home } as NodeJS.ProcessEnv;
      expect(detectAntigravity(env)).toBe(false);
      for (const root of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
        await mkdir(join(home, ".gemini", root), { recursive: true });
        expect(detectAntigravity(env)).toBe(true);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("antigravityNoticeLines", () => {
  it("only warns when the runtime cannot read SQLite", () => {
    const lines = antigravityNoticeLines();
    if (sqliteAvailable) {
      expect(lines).toEqual([]);
    } else {
      expect(lines.join(" ")).toMatch(/22\.5/);
    }
  });
});

describe("parseAntigravityGenMetadata", () => {
  it("decodes usage, splits thinking from response, and dates the turn", () => {
    const { genRows, stepRows } = fixture({ model: "gemini-3.8-flash-high" });
    const rows = parseAntigravityGenMetadata(genRows, stepRows, LOCAL_NOON);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-06-10",
      model: "gemini-3.8-flash-high",
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 10,
      cacheCreationTokens: 5,
      cacheReadTokens: 20,
    });
  });

  it("resolves a placeholder model from model_enum", () => {
    const { genRows, stepRows } = fixture({ placeholder: "MODEL_PLACEHOLDER_M318" });
    const rows = parseAntigravityGenMetadata(genRows, stepRows, LOCAL_NOON);
    expect(rows[0]?.model).toBe("gemini-3.8-flash-high");
  });

  it("dedupes repeated response ids within a file", () => {
    const { genRows, stepRows } = fixture();
    const rows = parseAntigravityGenMetadata(
      [genRows[0]!, { ...genRows[0]!, idx: 1 }],
      stepRows,
      LOCAL_NOON,
    );
    expect(rows).toHaveLength(1);
  });

  it("falls back to the file mtime when no timestamp is present", () => {
    const { genRows, stepRows } = fixture({
      model: "gemini-3.8-flash-high",
      withCreatedAt: false,
      withTimestamp: false,
    });
    const rows = parseAntigravityGenMetadata(genRows, stepRows, LOCAL_NOON);
    expect(rows[0]?.date).toBe("2026-06-10");
  });
});

describe("mapAntigravityUsageRows", () => {
  it("aggregates by date + model, counts requests, and bills thinking as output", () => {
    const entries = mapAntigravityUsageRows([
      {
        date: "2026-06-10",
        model: "gemini-3.8-flash-high",
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 10,
        cacheCreationTokens: 5,
        cacheReadTokens: 20,
      },
      {
        date: "2026-06-10",
        model: "gemini-3.8-flash-high",
        inputTokens: 50,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      date: "2026-06-10",
      tool: "antigravity",
      inputTokens: 150,
      outputTokens: 50,
      cacheCreationTokens: 5,
      cacheReadTokens: 20,
      requestCount: 2,
    });
    expect(entries[0]!.costUSD).toBeGreaterThan(0);
  });
});

describe.skipIf(!sqliteAvailable)("collectAntigravity (SQLite)", () => {
  it("reads a conversation DB end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-ag-db-"));
    try {
      const dir = join(root, "conversations");
      await mkdir(dir, { recursive: true });
      const { genRows, stepRows } = fixture({ model: "gemini-3.8-flash-high" });
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(join(dir, "cascade.db"));
      try {
        db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)");
        db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)");
        db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)").run(
          0,
          Buffer.from(genRows[0]!.data as Uint8Array),
          (genRows[0]!.data as Uint8Array).length,
        );
        db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)").run(
          0,
          Buffer.from(stepRows[0]!.metadata as Uint8Array),
        );
      } finally {
        db.close();
      }

      const result = await collectAntigravity({
        dirs: [dir],
        now: () => LOCAL_NOON,
      });
      expect(result).toMatchObject({ found: true, filesScanned: 1 });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        tool: "antigravity",
        model: "gemini-3.8-flash-high",
        inputTokens: 100,
        outputTokens: 40,
        cacheCreationTokens: 5,
        cacheReadTokens: 20,
        requestCount: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
