/**
 * Native reader for ZCode (Z.ai CLI).
 *
 * ZCode records exact per-request usage in SQLite at
 * `~/.zcode/cli/db/db.sqlite`, table `model_usage`. The JSONL activity log
 * redacts token counts and no local source stores a dollar cost, so this table
 * is the only usable billing ledger. Tokens are exact; cost is estimated from
 * the shared pricing table.
 *
 * ZCode folds cached tokens into `input_tokens` (OpenAI-style), so we split
 * cache reads/writes back out before pricing. `reasoning_tokens` is billed as
 * output but kept out of the token total, matching the other readers.
 *
 * `node:sqlite` (Node 22.5+) is required; on older Node this is a clean no-op.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "./shared.js";
import type { NativeCollectResult } from "./native/claude.js";
import { localUsageDate } from "./native/usage-date.js";
import { estimateCostUSD } from "./pricing.js";

/** Default ZCode usage database for the current user (may not exist). */
export function zcodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".zcode", "cli", "db", "db.sqlite");
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

export interface ZcodeUsageRow {
  model_id?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
}

interface ZcodeBucket {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}

function tokenCount(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function epochMs(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * PURE core: fold `model_usage` rows into per-(date, model) daily entries.
 * `completed_at ?? started_at` dates a request; cache tokens are split out of
 * the folded input count.
 */
export function mapZcodeUsageRows(
  rows: readonly ZcodeUsageRow[],
  now: number = Date.now(),
): DailyUsageEntry[] {
  const byKey = new Map<string, ZcodeBucket>();
  for (const row of rows) {
    const model =
      typeof row.model_id === "string" && row.model_id.trim()
        ? row.model_id.trim()
        : null;
    if (!model) continue;

    const input = tokenCount(row.input_tokens);
    const cacheRead = tokenCount(row.cache_read_input_tokens);
    const cacheCreation = tokenCount(row.cache_creation_input_tokens);
    const output = tokenCount(row.output_tokens);
    const reasoning = tokenCount(row.reasoning_tokens);
    const freshInput = Math.max(0, input - cacheRead - cacheCreation);
    if (freshInput + cacheRead + cacheCreation + output + reasoning === 0) continue;

    const ms = epochMs(row.completed_at ?? row.started_at);
    if (ms === null) continue;
    const date = localUsageDate(ms, now);
    if (!date) continue;

    const key = `${date}|${model}`;
    let b = byKey.get(key);
    if (!b) {
      b = {
        date,
        model,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      };
      byKey.set(key, b);
    }
    b.inputTokens += freshInput;
    b.outputTokens += output;
    b.reasoningTokens += reasoning;
    b.cacheCreationTokens += cacheCreation;
    b.cacheReadTokens += cacheRead;
    b.requestCount += 1;
  }

  return [...byKey.values()].map((b) => ({
    date: b.date,
    tool: "zcode",
    model: b.model,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheCreationTokens: b.cacheCreationTokens,
    cacheReadTokens: b.cacheReadTokens,
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

export interface CollectZcodeOpts {
  env?: NodeJS.ProcessEnv;
  /** Usage DB path (tests); defaults to `~/.zcode/cli/db/db.sqlite`. */
  dbPath?: string;
  now?: () => number;
}

/** Read ZCode's `model_usage` table and aggregate it by local day + model. */
export async function collectZcode(
  opts: CollectZcodeOpts = {},
): Promise<NativeCollectResult> {
  const dbPath = opts.dbPath ?? zcodeDbPath(opts.env ?? process.env);
  if (!existsSync(dbPath)) return { entries: [], found: false, filesScanned: 0 };

  const sqlite = nodeSqlite();
  if (!sqlite) return { entries: [], found: false, filesScanned: 0 };

  let db: InstanceType<typeof sqlite.DatabaseSync> | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT model_id, input_tokens, output_tokens, reasoning_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                started_at, completed_at
         FROM model_usage
         ORDER BY started_at ASC`,
      )
      .all() as unknown as ZcodeUsageRow[];
    return {
      entries: mapZcodeUsageRows(rows, (opts.now ?? Date.now)()),
      found: true,
      filesScanned: 1,
    };
  } catch (err) {
    // A locked DB is a bailed read; a missing/old schema is real "no data".
    const busy = /busy|locked/i.test(err instanceof Error ? err.message : String(err));
    return { entries: [], found: true, filesScanned: 1, ...(busy ? { timedOut: true } : {}) };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
