/**
 * Reader for claude.ai (web/desktop chat) usage exported by the companion
 * browser extension (https://github.com/nikkexe0-del/contexto).
 *
 * claude.ai keeps no local log and reports no token counts for chats, so the
 * extension reads your own conversations through claude.ai's API in the
 * browser and ESTIMATES tokens from text length. It then saves a file holding
 * only daily per-model totals, never chat text:
 *
 *   ~/Downloads/whoburnedmore-claude-web.json   (or WHOBURNEDMORE_CLAUDE_WEB=<path>)
 *
 * Each export is a full snapshot, so only the newest file is read (Chrome names
 * repeat downloads "whoburnedmore-claude-web (1).json" and so on). Rows are
 * tagged tool "claude-web" so they never mix with real Claude Code usage.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "./shared.js";
import type { NativeCollectResult } from "./native/claude.js";
import { estimateCostUSD } from "./pricing.js";
import { readTextFileSyncCapped } from "./safe-local-file.js";

export const CLAUDE_WEB_TOOL = "claude-web";
export const CLAUDE_WEB_FORMAT = "whoburnedmore.claude-web";
const FILE_RE = /^whoburnedmore-claude-web(?: ?\(\d+\))?\.json$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_RE = /^claude-[a-z0-9.-]{1,100}$/;

function count(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 && v < 1e13 ? v : 0;
}

/** PURE core: validate an export document and fold it into daily entries. */
export function mapClaudeWebExport(doc: unknown, now: number = Date.now()): DailyUsageEntry[] {
  if (!doc || typeof doc !== "object") return [];
  const d = doc as Record<string, unknown>;
  if (d.format !== CLAUDE_WEB_FORMAT || d.version !== 1 || !Array.isArray(d.days)) return [];
  const tomorrow = new Date(now + 864e5).toISOString().slice(0, 10);
  const byKey = new Map<string, DailyUsageEntry>();
  for (const raw of d.days.slice(0, MAX_ROWS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const date = typeof r.date === "string" && DATE_RE.test(r.date) ? r.date : null;
    if (!date || date < "2023-01-01" || date > tomorrow) continue;
    const model = typeof r.model === "string" ? r.model.toLowerCase() : "";
    if (!MODEL_RE.test(model)) continue;
    const usage = {
      inputTokens: count(r.inputTokens),
      outputTokens: count(r.outputTokens),
      cacheCreationTokens: count(r.cacheCreationTokens),
      cacheReadTokens: count(r.cacheReadTokens),
    };
    const total = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
    if (total === 0) continue;
    const key = `${date}|${model}`;
    const e = byKey.get(key) ?? {
      date, tool: CLAUDE_WEB_TOOL, model,
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
      costUSD: 0, origin: "cli" as const, verified: false, requestCount: 0,
    };
    e.inputTokens += usage.inputTokens;
    e.outputTokens += usage.outputTokens;
    e.cacheCreationTokens += usage.cacheCreationTokens;
    e.cacheReadTokens += usage.cacheReadTokens;
    e.costUSD = Number((e.costUSD + estimateCostUSD(model, usage)).toFixed(6));
    e.requestCount = (e.requestCount ?? 0) + count(r.replies);
    byKey.set(key, e);
  }
  return [...byKey.values()];
}

/** Newest matching export in the Downloads folder, or the env override. */
export function findClaudeWebExport(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WHOBURNEDMORE_CLAUDE_WEB) return env.WHOBURNEDMORE_CLAUDE_WEB;
  const dir = join(env.USERPROFILE || env.HOME || homedir(), "Downloads");
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!FILE_RE.test(name)) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path, mtime: st.mtimeMs };
      } catch {
        // vanished or unreadable: skip
      }
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

export async function collectClaudeWeb(
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<NativeCollectResult> {
  const env = opts.env ?? process.env;
  if (env.WHOBURNEDMORE_CLAUDE_WEB === "0") return { entries: [], found: false, filesScanned: 0 };
  const path = findClaudeWebExport(env);
  if (!path) return { entries: [], found: false, filesScanned: 0 };
  const text = readTextFileSyncCapped(path, MAX_BYTES);
  if (text === null) return { entries: [], found: false, filesScanned: 0 };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { entries: [], found: false, filesScanned: 1 };
  }
  const entries = mapClaudeWebExport(doc, opts.now);
  return { entries, found: entries.length > 0, filesScanned: 1 };
}
