/**
 * Native reader for Google Antigravity (desktop, CLI, and IDE).
 *
 * Antigravity keeps a SQLite conversation ledger under
 * `~/.gemini/<antigravity|antigravity-cli|antigravity-ide>/conversations/*.db`.
 * Each `gen_metadata` row holds a protobuf-encoded chat turn whose
 * `ModelUsageStats` submessage records exact input/output/cache/thinking token
 * counts, a model id, and a timestamp. That is a real per-request usage row, so
 * we read it directly instead of relying on an external bridge.
 *
 * The older `.pb` cascade files are only readable through Antigravity's live
 * RPC server (and the local corpus writes all usage into `.db`); we leave them
 * alone and count the SQLite ledger only.
 *
 * Best-effort + defensive: every protobuf field is bounds-checked, malformed
 * rows are skipped, and the read is time-bounded. `node:sqlite` (Node 22.5+)
 * is required; on older Node the reader is a clean no-op and the CLI notice
 * explains the upgrade.
 *
 * Split into a PURE core (`parseAntigravityGenMetadata`,
 * `mapAntigravityUsageRows`) the tests drive with fixtures and a filesystem
 * wrapper (`collectAntigravity`).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "./shared.js";
import type { NativeCollectResult } from "./native/claude.js";
import { NATIVE_READ_BUDGET_MS } from "./native/claude.js";
import { localUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";

const ANTGRAVITY_ROOTS = [
  "antigravity",
  "antigravity-cli",
  "antigravity-ide",
] as const;

/** Antigravity data directories for the current user (may not exist). */
export function antigravityDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  return ANTGRAVITY_ROOTS.map((root) => join(home, ".gemini", root));
}

/** The primary Antigravity data directory for the current user. */
export function antigravityDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return antigravityDataDirs(env)[0]!;
}

/** True when any Antigravity variant appears to be installed for this user. */
export function detectAntigravity(env: NodeJS.ProcessEnv = process.env): boolean {
  return antigravityDataDirs(env).some((dir) => existsSync(dir));
}

/** Node's built-in SQLite module, or null on Node < 22.5. */
function nodeSqlite(): typeof import("node:sqlite") | null {
  try {
    const require = createRequire(import.meta.url);
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch {
    return null;
  }
}

/**
 * Plain-text lines for a detected Antigravity install on a Node version that
 * cannot read its SQLite ledger. Empty when the current runtime can read it.
 */
export function antigravityNoticeLines(): string[] {
  if (nodeSqlite()) return [];
  return [
    "  • Google Antigravity detected — its local SQLite usage ledger needs Node.js 22.5+.",
    `    You're running Node ${process.version}; upgrade Node to count Antigravity usage.`,
  ];
}

// ---------------------------------------------------------------------------
// Protobuf helpers (exa.codeium_common_pb.ModelUsageStats + chat metadata).
// ---------------------------------------------------------------------------

interface ProtoField {
  number: number;
  wireType: number;
  value?: bigint;
  bytes?: Uint8Array;
}

interface ProtoVarint {
  value: bigint;
  offset: number;
}

const protoTextDecoder = new TextDecoder("utf-8", { fatal: false });

function readProtoVarint(data: Uint8Array, startOffset: number): ProtoVarint | null {
  let value = 0n;
  let shift = 0n;
  let offset = startOffset;

  while (offset < data.length) {
    const byte = BigInt(data[offset]!);
    offset += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value, offset };
    shift += 7n;
    if (shift > 70n) return null;
  }

  return null;
}

function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < data.length) {
    const key = readProtoVarint(data, offset);
    if (!key) break;
    offset = key.offset;

    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) break;

    if (wireType === 0) {
      const value = readProtoVarint(data, offset);
      if (!value) break;
      fields.push({ number: fieldNumber, wireType, value: value.value });
      offset = value.offset;
      continue;
    }

    if (wireType === 1) {
      if (offset + 8 > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }

    if (wireType === 2) {
      const length = readProtoVarint(data, offset);
      if (!length) break;
      offset = length.offset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + byteLength) });
      offset += byteLength;
      continue;
    }

    if (wireType === 5) {
      if (offset + 4 > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }

    break;
  }

  return fields;
}

function firstProtoField(fields: readonly ProtoField[], fieldNumber: number): ProtoField | undefined {
  return fields.find((field) => field.number === fieldNumber);
}

function protoFieldText(field: ProtoField | undefined): string | undefined {
  if (!field?.bytes || field.bytes.length === 0) return undefined;
  const text = protoTextDecoder.decode(field.bytes);
  if (!text || /[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(text)) return undefined;
  return text;
}

function protoFieldPositiveInteger(field: ProtoField | undefined): number {
  if (field?.value === undefined) return 0;
  const value = Number(field.value);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function protoFieldBytes(field: ProtoField | undefined): Uint8Array | undefined {
  return field?.bytes;
}

function toProtoBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function decodePackedVarints(data: Uint8Array): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset < data.length) {
    const res = readProtoVarint(data, offset);
    if (!res) break;
    values.push(Number(res.value));
    offset = res.offset;
  }
  return values;
}

function protoTimestampToMs(field: ProtoField | undefined): number | null {
  if (!field) return null;
  const text = protoFieldText(field);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (field.bytes) {
    // google.protobuf.Timestamp submessage: seconds (#1), nanos (#2).
    const tsFields = parseProtoFields(field.bytes);
    const seconds = firstProtoField(tsFields, 1)?.value;
    if (seconds !== undefined) {
      const nanos = firstProtoField(tsFields, 2)?.value ?? 0n;
      const ms = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6);
      if (Number.isSafeInteger(ms) && ms > 0) return ms;
    }
  }
  if (field.value !== undefined) {
    const raw = Number(field.value);
    const ms = raw < 1e12 ? raw * 1000 : raw;
    if (Number.isSafeInteger(ms) && ms > 0) return ms;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model resolution.
// ---------------------------------------------------------------------------

const MODEL_PLACEHOLDER_PATTERN = /^MODEL_PLACEHOLDER_/;

function dropPlaceholderModelId(model: string | undefined): string {
  if (!model) return "unknown";
  return MODEL_PLACEHOLDER_PATTERN.test(model) ? "unknown" : model;
}

function getCanonicalModelId(key: string, displayName?: string): string {
  if (displayName) {
    const lower = displayName.toLowerCase();
    if (lower.includes("3.5 flash")) {
      if (lower.includes("high")) return "gemini-3.5-flash-high";
      if (lower.includes("medium")) return "gemini-3.5-flash-medium";
      if (lower.includes("low")) return "gemini-3.5-flash-low";
      return "gemini-3.5-flash";
    }
    if (lower.includes("3.1 pro")) {
      if (lower.includes("high")) return "gemini-3.1-pro-high";
      if (lower.includes("low")) return "gemini-3.1-pro-low";
      return "gemini-3.1-pro";
    }
    if (lower.includes("3.1 flash")) {
      if (lower.includes("image")) return "gemini-3.1-flash-image";
      if (lower.includes("lite")) return "gemini-3.1-flash-lite";
      return "gemini-3.1-flash";
    }
    if (lower.includes("3 flash")) return "gemini-3-flash";
    if (lower.includes("3 pro")) return "gemini-3-pro";
  }
  return dropPlaceholderModelId(key);
}

// The standalone app writes only the placeholder enum and a generic display
// name, so these are the ids its own model catalog resolved them to.
const PLACEHOLDER_MODELS: Record<string, string> = {
  MODEL_PLACEHOLDER_M16: "gemini-3.1-pro-high",
  MODEL_PLACEHOLDER_M37: "gemini-3.1-pro-high",
  MODEL_PLACEHOLDER_M36: "gemini-3.1-pro-low",
  MODEL_PLACEHOLDER_M84: "gemini-3.5-flash-high",
  MODEL_PLACEHOLDER_M18: "gemini-3-flash",
  MODEL_PLACEHOLDER_M318: "gemini-3.8-flash-high",
  MODEL_PLACEHOLDER_M319: "gemini-3.8-flash-medium",
  MODEL_PLACEHOLDER_M320: "gemini-3.8-flash-low",
  MODEL_PLACEHOLDER_M35: "claude-sonnet-4-6",
  MODEL_PLACEHOLDER_M26: "claude-opus-4-6-thinking",
};

function antigravityMetadataAttributes(chatFields: readonly ProtoField[]): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const field of chatFields) {
    if (field.number !== 20) continue;
    const pair = parseProtoFields(protoFieldBytes(field) ?? new Uint8Array());
    const key = protoFieldText(firstProtoField(pair, 1));
    const value = protoFieldText(firstProtoField(pair, 2));
    if (key && value) attrs.set(key, value);
  }
  return attrs;
}

function antigravityModel(chatFields: readonly ProtoField[]): string {
  const attributes = antigravityMetadataAttributes(chatFields);
  const displayName = protoFieldText(firstProtoField(chatFields, 21));
  const placeholderModel = PLACEHOLDER_MODELS[attributes.get("model_enum") ?? ""];
  if (!displayName && placeholderModel) return placeholderModel;
  const rawModel =
    protoFieldText(firstProtoField(chatFields, 19)) ??
    attributes.get("model_enum") ??
    displayName ??
    "unknown";
  return getCanonicalModelId(rawModel, displayName);
}

// ---------------------------------------------------------------------------
// Pure parse + aggregate.
// ---------------------------------------------------------------------------

export interface AntigravityGenMetadataRow {
  idx: number;
  data: Uint8Array | string;
}

export interface AntigravityStepRow {
  idx: number;
  metadata: Uint8Array | string | null;
}

export interface AntigravityUsageRow {
  date: string;
  model: string;
  inputTokens: number;
  /** Visible response tokens; thinking is billed but tracked separately. */
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * PURE core: decode `gen_metadata` + `steps` rows into per-request usage rows.
 * `fallbackMs` (usually the DB file mtime) dates turns whose metadata has no
 * timestamp.
 */
export function parseAntigravityGenMetadata(
  genRows: readonly AntigravityGenMetadataRow[],
  stepRows: readonly AntigravityStepRow[],
  fallbackMs: number,
  now: number = Date.now(),
): AntigravityUsageRow[] {
  const stepMap = new Map<number, AntigravityStepRow>();
  for (const step of stepRows) stepMap.set(step.idx, step);

  const calls: AntigravityUsageRow[] = [];
  const seenResponseIds = new Set<string>();

  for (const row of genRows) {
    const rootFields = parseProtoFields(toProtoBytes(row.data));
    const stepIndices: number[] = [];
    for (const field of rootFields) {
      if (field.number === 2 && field.bytes) {
        stepIndices.push(...decodePackedVarints(field.bytes));
      }
    }

    // The standalone app omits ChatStartMetadata.created_at; the generation's
    // first step carries the same time (steps.metadata #1).
    const firstStep = stepIndices.length > 0 ? stepMap.get(stepIndices[0]!) : undefined;
    const firstStepMs = firstStep?.metadata
      ? protoTimestampToMs(
          firstProtoField(parseProtoFields(toProtoBytes(firstStep.metadata)), 1),
        )
      : null;

    const chatFields = parseProtoFields(
      protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array(),
    );
    const usageFields = parseProtoFields(
      protoFieldBytes(firstProtoField(chatFields, 4)) ?? new Uint8Array(),
    );
    if (usageFields.length === 0) continue;

    // exa.codeium_common_pb.ModelUsageStats: 2 input (uncached), 3 output
    // (thinking + response), 4 cache write, 5 cache read, 9 thinking,
    // 10 response, 11 response id.
    const inputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 2));
    const totalOutputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 3));
    const cacheWriteTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 4));
    const cacheReadTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 5));
    const thinkingTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 9));
    let responseTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 10));

    if (responseTokens === 0 && thinkingTokens === 0) {
      responseTokens = totalOutputTokens;
    } else if (totalOutputTokens > 0 && responseTokens + thinkingTokens !== totalOutputTokens) {
      const adjusted = totalOutputTokens - thinkingTokens;
      if (adjusted >= 0) responseTokens = adjusted;
    }

    if (inputTokens === 0 && totalOutputTokens === 0) continue;

    const responseId =
      protoFieldText(firstProtoField(usageFields, 11)) ?? String(row.idx);
    if (seenResponseIds.has(responseId)) continue;
    seenResponseIds.add(responseId);

    const metaBytes = protoFieldBytes(firstProtoField(chatFields, 9));
    const createdAtMs = metaBytes
      ? protoTimestampToMs(
          firstProtoField(parseProtoFields(metaBytes), 4),
        )
      : null;
    const date = localUsageDate(createdAtMs ?? firstStepMs ?? fallbackMs, now);
    if (!date) continue;

    calls.push({
      date,
      model: antigravityModel(chatFields),
      inputTokens,
      outputTokens: responseTokens,
      reasoningTokens: thinkingTokens,
      cacheCreationTokens: cacheWriteTokens,
      cacheReadTokens: cacheReadTokens,
    });
  }

  return calls;
}

interface AntigravityBucket {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}

/** PURE core: fold per-request rows into per-(date, model) daily entries. */
export function mapAntigravityUsageRows(
  rows: readonly AntigravityUsageRow[],
): DailyUsageEntry[] {
  const byKey = new Map<string, AntigravityBucket>();
  for (const row of rows) {
    const key = `${row.date}|${row.model}`;
    let b = byKey.get(key);
    if (!b) {
      b = {
        date: row.date,
        model: row.model,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      };
      byKey.set(key, b);
    }
    b.inputTokens += row.inputTokens;
    b.outputTokens += row.outputTokens;
    b.reasoningTokens += row.reasoningTokens;
    b.cacheCreationTokens += row.cacheCreationTokens;
    b.cacheReadTokens += row.cacheReadTokens;
    b.requestCount += 1;
  }

  return [...byKey.values()].map((b) => ({
    date: b.date,
    tool: "antigravity",
    model: b.model,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheCreationTokens: b.cacheCreationTokens,
    cacheReadTokens: b.cacheReadTokens,
    // Thinking is not a separate wire field, but it is billable output.
    costUSD: Number(
      estimateCostUSD(b.model, {
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens + b.reasoningTokens,
        cacheCreationTokens: b.cacheCreationTokens,
        cacheReadTokens: b.cacheReadTokens,
      }).toFixed(6),
    ),
    origin: "cli",
    verified: false,
    requestCount: b.requestCount,
  }));
}

// ---------------------------------------------------------------------------
// Filesystem wrapper.
// ---------------------------------------------------------------------------

type SqliteModule = typeof import("node:sqlite");

function readAntigravityDb(
  sqlite: SqliteModule,
  file: string,
  fallbackMs: number,
): { rows: AntigravityUsageRow[]; busy: boolean } {
  let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const genRows = db
      .prepare("SELECT idx, data FROM gen_metadata ORDER BY idx")
      .all() as unknown as AntigravityGenMetadataRow[];
    if (genRows.length === 0) return { rows: [], busy: false };

    let stepRows: AntigravityStepRow[] = [];
    try {
      stepRows = db
        .prepare("SELECT idx, metadata FROM steps ORDER BY idx")
        .all() as unknown as AntigravityStepRow[];
    } catch {
      // steps is optional: timestamps then fall back to the file mtime.
    }

    return {
      rows: parseAntigravityGenMetadata(genRows, stepRows, fallbackMs),
      busy: false,
    };
  } catch (err) {
    // A locked DB must not be treated as empty: that would submit an
    // undercounted history. The caller bails instead and retries next sync.
    const busy = /busy|locked/i.test(err instanceof Error ? err.message : String(err));
    return { rows: [], busy };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

export interface CollectAntigravityOpts {
  env?: NodeJS.ProcessEnv;
  /** Direct conversation directories to scan (tests); defaults to the real roots. */
  dirs?: string[];
  budgetMs?: number;
  now?: () => number;
}

/**
 * Read every Antigravity SQLite conversation ledger and aggregate it. Best
 * effort and time-bounded like the other native readers: `found:false` when
 * Antigravity isn't installed or `node:sqlite` is unavailable, `timedOut:true`
 * rather than submitting a partial corpus.
 */
export async function collectAntigravity(
  opts: CollectAntigravityOpts = {},
): Promise<NativeCollectResult> {
  const sqlite = nodeSqlite();
  if (!sqlite) return { entries: [], found: false, filesScanned: 0 };

  const dirs =
    opts.dirs ??
    antigravityDataDirs(opts.env ?? process.env).map((dir) =>
      join(dir, "conversations"),
    );
  const files: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.toLowerCase().endsWith(".db")) files.push(join(dir, name));
    }
  }
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const rows: AntigravityUsageRow[] = [];
  let scanned = 0;

  for (const file of files) {
    if (now() > deadline) {
      return { entries: [], found: true, filesScanned: scanned, timedOut: true };
    }
    let mtimeMs = now();
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // keep the wall-clock fallback
    }
    const read = readAntigravityDb(sqlite, file, mtimeMs);
    if (read.busy) {
      return { entries: [], found: true, filesScanned: scanned, timedOut: true };
    }
    rows.push(...read.rows);
    scanned += 1;
  }

  return {
    entries: mapAntigravityUsageRows(rows),
    found: true,
    filesScanned: scanned,
  };
}
