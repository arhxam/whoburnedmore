/**
 * Native reader for Qoder CLI (https://qoder.com/cli).
 *
 * Why this exists: `ccusage` can't see Qoder — it isn't one of ccusage's
 * sources, and Qoder's transcript format is its own. So we parse it ourselves,
 * the same way the Claude/Codex/Cline/Roo/Continue readers do.
 *
 * Where the data lives: Qoder writes one JSONL transcript per session under
 * `~/.qoder/projects/<encoded-cwd>/<sessionId>.jsonl`, plus one per subagent
 * under `.../subagents/*.jsonl`. Both are append-only.
 *
 * THE HARD PART — Qoder records CREDITS, not tokens. Every `message.usage`
 * object on an assistant turn carries
 *   input_tokens / output_tokens / cache_creation_input_tokens /
 *   cache_read_input_tokens === 0
 * and, instead, `credits` (a float) plus `context_usage_ratio` (how full the
 * model's context window was). Qoder proxies the upstream models server-side
 * (`provider="qoder"`), so the provider's own token counts never reach the
 * client, and the API response carries zeros too. We confirmed this on every
 * surface: transcripts, `qodercli.log` (`model.response.completed ...
 * input_tokens=0 output_tokens=0`), the inference response, and the
 * credentials-billed `/api/v2/quota/usage` endpoint (which reports credits and
 * a percentage, never tokens). There is no token ledger to read.
 *
 * So the token counts are RECONSTRUCTED, not fabricated, from two real
 * measurements Qoder does make:
 *
 *   inputTokens  = context_usage_ratio x context window
 *                  `context_usage_ratio` is Qoder's own report of how full the
 *                  context was for that request, and the agentic loop replays
 *                  the whole context every turn — so this IS the prompt size.
 *                  Cross-check: the first turn of two unrelated sessions
 *                  ("auto" @200k and "dfmodel" @1M) both land on ~38k tokens,
 *                  i.e. the shared system-prompt + 81-tool-schema prefix. A
 *                  wrong window would not agree across both.
 *
 *   outputTokens = a character-count estimate over the response body, which
 *                  IS in the transcript (text + thinking + tool_use payloads).
 *                  Output is ~0.1% of an agentic session's tokens (the context
 *                  dominates), so a coarse estimate cannot move the day total.
 *
 * The context window is `runtime-config.contextWindow` when the session
 * overrode it, else the model's `max_input_tokens`. The override is NOT
 * cosmetic: in one captured session the window was changed 1,000,000 ->
 * 200,000 mid-session, and `context_usage_ratio` was recomputed against the
 * new window from that point on — so the reader tracks the per-session
 * `runtime-config` timeline instead of using one window for the whole file.
 * The model's own `max_input_tokens` is not in the transcript; Qoder logs it
 * as `model_config={...,"max_input_tokens":N}` in its run logs, which we parse
 * and cache, with a small built-in table for the tier keys we know.
 *
 * `credits` is deliberately NOT used for tokens: Qoder's credit formula is
 * undocumented and is not a linear function of context or output tokens (it
 * also folds in model tier, caching and API duration), so inverting it would
 * be guesswork. Cost is estimated from the token counts with the standard
 * pricing table, exactly like the Continue reader does.
 *
 * Cache tokens are reported as 0: Qoder does not expose its upstream cache
 * split, so we do not claim one.
 *
 * Purely additive + best-effort: when Qoder isn't installed there's no
 * `~/.qoder` dir and the reader returns `found:false`, changing nothing.
 */
import { readdir } from "node:fs/promises";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";
import type { NativeCollectResult } from "./claude.js";
import { NATIVE_READ_BUDGET_MS } from "./claude.js";
import { nativeCachePath, readFilesWithCache } from "./file-cache.js";
import { localUsageDate } from "./usage-date.js";

/** Per-model metadata recovered from Qoder's run logs. */
export interface QoderModelInfo {
  /** The name Qoder shows for the tier, e.g. "DeepSeek-Flash". */
  displayName: string;
  /** The tier's context window (`max_input_tokens`). */
  maxInputTokens: number;
}

/**
 * Tier keys we've confirmed, used only when the run logs (which are pruned)
 * no longer mention them. `dfmodel` is the flagship DeepSeek tier (1M window),
 * `auto`/`lite` are the 200k tiers.
 */
const BUILTIN_MODELS: Record<string, QoderModelInfo> = {
  auto: { displayName: "Auto", maxInputTokens: 200_000 },
  lite: { displayName: "lite", maxInputTokens: 200_000 },
  dfmodel: { displayName: "DeepSeek-Flash", maxInputTokens: 1_000_000 },
};

/** `model_config={"key":...,"display_name":...,"max_input_tokens":N}` in the logs. */
const MODEL_CONFIG_RE = /model_config=(\{.*?\}),\s*custom_model=/g;

/**
 * How much of a run log to read. The `model_config` lines are written with
 * the first requests of a run, so a head read is enough — and a long session's
 * log can be tens of megabytes.
 */
const LOG_HEAD_BYTES = 8 * 1024 * 1024;

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Approximate the token count of a model response.
 *
 * Qoder never reports output tokens, but the response body IS in the
 * transcript, so we measure it rather than guess: ~4 characters per token for
 * latin text, ~1.5 for CJK. Deliberately coarse — output tokens are ~0.1% of
 * an agentic session's total (the replayed context dominates), so a precise
 * tokenizer would buy nothing here.
 */
export function estimateOutputTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x3000 && cp <= 0x9fff) cjk++;
  }
  const latin = text.length - cjk;
  return Math.round(latin / 4 + cjk / 1.5);
}

/** Flatten an assistant message's content blocks into the text the model sent. */
function responseText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string")
      parts.push(b.thinking);
    else if (b.type === "tool_use") parts.push(JSON.stringify(b.input ?? {}));
  }
  return parts.join("\n");
}

/**
 * One reconstructed request, as cached per transcript file.
 * `[date, modelKey, ratio, outputTokens, windowOverride]`
 *
 * The ratio and the window override are cached instead of the final token
 * count because the model's own window comes from the run logs, which change
 * independently of the transcript. Applying the window at merge time keeps a
 * cached file correct when a later log reveals a different `max_input_tokens`.
 */
export type QoderCachedRow = [
  string,
  string,
  number,
  number,
  number | null,
];

/**
 * PURE core: fold one transcript file's records into reconstructed requests.
 *
 * `runtime-config` records carry the session's active model and an optional
 * explicit context window. Transcripts are append-only and chronologically
 * ordered, so the last `runtime-config` seen before a turn is the one in force
 * for it.
 */
export function parseQoderJsonl(content: string): QoderCachedRow[] {
  const rows: QoderCachedRow[] = [];
  let windowOverride: number | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // corrupt line — skip
    }

    if (obj.type === "runtime-config") {
      const cw = obj.contextWindow;
      const v = typeof cw === "number" && Number.isFinite(cw) && cw > 0 ? cw : null;
      windowOverride = v;
      continue;
    }

    if (obj.type !== "assistant") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") continue;
    const ratio = Number(usage.context_usage_ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;

    const ts = Date.parse(String(obj.timestamp ?? ""));
    const date = localUsageDate(ts);
    if (!date) continue;

    const modelKey =
      typeof message.model === "string" && message.model ? message.model : "unknown";
    const outputTokens = estimateOutputTokens(responseText(message.content));

    rows.push([date, modelKey, ratio, outputTokens, windowOverride]);
  }
  return rows;
}

/**
 * Read the HEAD of a file, regardless of how large the file is.
 *
 * Qoder's run log for a long session grows without bound (a busy day reaches
 * tens of megabytes), and the `model_config` lines we want are written in the
 * first requests of the run — so a bounded head read is both correct and
 * cheap. `readTextFileCapped` can't be used here: it REJECTS a file larger
 * than its cap outright, which would silently drop exactly the biggest (and
 * most recent) runs.
 */
async function readHead(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Recover the tier key -> {display name, context window} map from Qoder's run
 * logs. The logs are the only place the model's `max_input_tokens` appears;
 * they are pruned over time, so the built-in table backfills the tiers we
 * know. Best effort: a miss just means that tier's turns can't be priced.
 */
export async function readQoderModels(
  qoderDir: string,
  opts: { deadline: number; now: () => number; maxLogs?: number },
): Promise<Map<string, QoderModelInfo>> {
  const models = new Map<string, QoderModelInfo>();
  for (const [key, info] of Object.entries(BUILTIN_MODELS)) {
    models.set(key, { ...info });
  }

  let runDirs: string[] = [];
  try {
    const entries = await readdir(join(qoderDir, "logs", "runs"), {
      withFileTypes: true,
    });
    runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return models; // no logs dir — built-in table only
  }

  // Newest runs first: a tier that is still in use shows up in the latest log.
  runDirs.sort().reverse();
  const maxLogs = Math.max(1, opts.maxLogs ?? 40);
  for (const run of runDirs.slice(0, maxLogs)) {
    if (opts.now() > opts.deadline) break;
    const content = await readHead(
      join(qoderDir, "logs", "runs", run, "qodercli.log"),
      LOG_HEAD_BYTES,
    );
    if (!content) continue;
    MODEL_CONFIG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MODEL_CONFIG_RE.exec(content)) !== null) {
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(match[1]!) as Record<string, unknown>;
      } catch {
        continue;
      }
      const key = cfg.key;
      const maxInputTokens = num(cfg.max_input_tokens);
      if (typeof key !== "string" || !key || maxInputTokens <= 0) continue;
      const displayName =
        typeof cfg.display_name === "string" && cfg.display_name
          ? cfg.display_name
          : key;
      models.set(key, { displayName, maxInputTokens });
    }
  }
  return models;
}

/** Discover transcript files: `~/.qoder/projects/<project>/<session>.jsonl`. */
async function listTranscripts(
  root: string,
  opts: { deadline: number; now: () => number; maxFiles: number },
): Promise<{ files: string[]; aborted: boolean }> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let queueIndex = 0;
  const files: string[] = [];
  while (queueIndex < queue.length) {
    if (opts.now() > opts.deadline) return { files: [], aborted: true };
    const current = queue[queueIndex++]!;
    let dirents;
    try {
      dirents = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = join(current.dir, d.name);
      if (d.isDirectory()) {
        if (current.depth >= 8) continue;
        queue.push({ dir: full, depth: current.depth + 1 });
      } else if (d.isFile() && d.name.endsWith(".jsonl")) {
        files.push(full);
        if (files.length > opts.maxFiles) return { files: [], aborted: true };
      }
    }
  }
  return { files, aborted: false };
}

/** Bump when parse/aggregate semantics change — invalidates the per-file cache. */
export const QODER_CACHE_VERSION = 1;

export interface CollectQoderOpts {
  /** Qoder home dir (default `~/.qoder`). */
  qoderDir?: string;
  env?: NodeJS.ProcessEnv;
  budgetMs?: number;
  now?: () => number;
  cachePath?: string;
  maxFiles?: number;
}

/**
 * Read Qoder CLI transcripts and aggregate them into daily entries.
 * Best-effort and time-bounded like the other native readers: `found:false`
 * when Qoder isn't installed, `timedOut:true` on a budget timeout rather than
 * submitting a partial corpus.
 */
export async function collectQoder(
  opts: CollectQoderOpts = {},
): Promise<NativeCollectResult> {
  const env = opts.env ?? process.env;
  const home = opts.qoderDir ?? join(env.HOME || homedir(), ".qoder");
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);

  const discovery = await listTranscripts(join(home, "projects"), {
    deadline,
    now,
    maxFiles: Math.max(1, opts.maxFiles ?? 20_000),
  });
  if (discovery.aborted) {
    return { entries: [], found: false, filesScanned: 0, timedOut: true };
  }
  const files = discovery.files;
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const res = await readFilesWithCache<QoderCachedRow>({
    files,
    cachePath: opts.cachePath ?? nativeCachePath("qoder", env),
    version: QODER_CACHE_VERSION,
    parseFile: (content) => parseQoderJsonl(content),
    deadline,
    now,
  });
  if (!res.itemsByFile) {
    return { entries: [], found: false, filesScanned: res.filesRead, timedOut: true };
  }

  const models = await readQoderModels(home, { deadline, now });

  // Merge into per-(date, model) buckets. Qoder's transcripts are append-only
  // and a session's rows are unique, so no cross-file dedup is needed.
  interface Bucket {
    date: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    requestCount: number;
  }
  const byKey = new Map<string, Bucket>();
  for (const rows of res.itemsByFile) {
    for (const [date, modelKey, ratio, outputTokens, windowOverride] of rows) {
      const info = models.get(modelKey);
      const window = windowOverride ?? info?.maxInputTokens ?? 0;
      // Without a window the ratio is meaningless, so the turn can't be sized.
      if (window <= 0) continue;
      const inputTokens = Math.round(ratio * window);
      if (inputTokens <= 0 && outputTokens <= 0) continue;

      const model = info?.displayName ?? modelKey;
      const key = `${date}|${model}`;
      let b = byKey.get(key);
      if (!b) {
        b = { date, model, inputTokens: 0, outputTokens: 0, costUSD: 0, requestCount: 0 };
        byKey.set(key, b);
      }
      b.inputTokens += inputTokens;
      b.outputTokens += outputTokens;
      b.costUSD += estimateCostUSD(model, {
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      // One reconstructed turn == one real provider request, which is the
      // anti-fraud fingerprint the server checks.
      b.requestCount += 1;
    }
  }

  const entries: DailyUsageEntry[] = [...byKey.values()].map((b) => ({
    date: b.date,
    tool: "qoder",
    model: b.model,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: Number(b.costUSD.toFixed(6)),
    origin: "cli",
    verified: false,
    requestCount: b.requestCount,
  }));
  return { entries, found: true, filesScanned: res.filesRead };
}
