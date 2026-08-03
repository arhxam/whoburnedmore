/**
 * BurnBar's collection orchestrator. Mirrors the CLI collectAll() but is
 * compiled-binary-safe: collectAll resolves the ccusage JS bin through
 * require.resolve, which cannot work inside a bun single-file executable, so we
 * re-orchestrate here and spawn the standalone ccusage PLATFORM BINARY instead
 * (shipped in BurnBar.app/Contents/Resources, path via BURNBAR_CCUSAGE).
 *
 * Two tiers:
 *  - collectNative(): the fast, file-watch-driven tier — Claude Code, Codex,
 *    Cline, Roo, Continue via the CLI's battle-tested native readers with their
 *    persistent per-file caches (steady-state = only changed files re-parsed).
 *  - collectSlow(): the long-tail tier on a timer — every ccusage source plus
 *    the Cursor dashboard API (network) — merged over the latest native tier.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { DailyUsageEntry, SessionEntry } from "../../../src/shared.js";

import {
  SOURCES,
  ccusageClaudeEnv,
  dedupeDaily,
  mapCcusageDaily,
  mapCcusageSessions,
  selectSourceEntries,
} from "../../../src/collect.js";
import { readdirSync } from "node:fs";

import { collectContinue } from "../../../src/continue.js";
import { resolveClaudeProjectDirs } from "../../../src/native/claude.js";
import { collectCursor } from "../../../src/cursor.js";
import {
  collectClaudeNative,
  type NativeCollectResult,
} from "../../../src/native/claude.js";
import { collectCodexNative } from "../../../src/native/codex.js";
import {
  VSCODE_AGENTS,
  collectVscodeAgent,
} from "../../../src/native/vscode-agents.js";
import { loadLivePricing } from "../../../src/pricing-live.js";

const execFileAsync = promisify(execFile);

const EMPTY_NATIVE: NativeCollectResult = { entries: [], found: false, filesScanned: 0 };

/** BurnBar keeps its own cache dir so it never races the launchd CLI sync's caches. */
export function burnbarCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir =
    env.BURNBAR_CACHE_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "burnbar");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface NativeTier {
  /** Per-source entries, pre-merge (claude/codex kept separate for selectSourceEntries). */
  claude: NativeCollectResult;
  codex: NativeCollectResult;
  others: DailyUsageEntry[];
  toolsFound: string[];
  partial: boolean;
}

export async function collectNativeTier(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeTier> {
  await loadLivePricing().catch(() => {});
  const cacheDir = burnbarCacheDir(env);
  const cache = (name: string) => join(cacheDir, `native-cache-${name}.json`);

  const [claude, codex, cont, ...vscode] = await Promise.all([
    collectClaudeNative(env, { cachePath: cache("claude") }).catch(() => EMPTY_NATIVE),
    collectCodexNative(env, { cachePath: cache("codex") }).catch(() => EMPTY_NATIVE),
    collectContinue({ env, cachePath: cache("continue") }).catch(() => EMPTY_NATIVE),
    ...VSCODE_AGENTS.map((a) =>
      collectVscodeAgent({ tool: a.tool, extIds: a.extIds, env, cachePath: cache(`vscode-${a.tool}`) }).catch(
        () => EMPTY_NATIVE,
      ),
    ),
  ]);

  const toolsFound: string[] = [];
  if (claude.found) toolsFound.push("claude");
  if (codex.found) toolsFound.push("codex");
  if (cont.found) toolsFound.push("continue");
  vscode.forEach((r, i) => {
    if (r.found) toolsFound.push(VSCODE_AGENTS[i].tool);
  });

  return {
    claude,
    codex,
    others: [...cont.entries, ...vscode.flatMap((r) => r.entries)],
    toolsFound,
    partial: [claude, codex, cont, ...vscode].some((r) => r.timedOut === true),
  };
}

export interface SlowTier {
  /** ccusage entries per source (claude/codex included as fallback candidates). */
  bySource: Map<string, DailyUsageEntry[]>;
  cursor: DailyUsageEntry[];
  /** ccusage `session` rollup (aggregate per-conversation totals). */
  sessions: SessionEntry[];
  toolsFound: string[];
}

/** Locate the standalone ccusage binary: env override, else the workspace dep (dev). */
export function resolveCcusageStandalone(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BURNBAR_CCUSAGE) return env.BURNBAR_CCUSAGE;
  return null;
}

async function runCcusageBinary(
  bin: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<unknown | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 25_000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout ? JSON.parse(stdout) : null;
  } catch {
    return null;
  }
}

export async function collectSlowTier(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlowTier> {
  const bin = resolveCcusageStandalone(env);
  const bySource = new Map<string, DailyUsageEntry[]>();
  let toolsFound: string[] = [];
  let sessions: SessionEntry[] = [];

  const cursorTask = collectCursor().catch(() => ({ entries: [], blocks: [], found: false }));

  if (bin) {
    const [results, sessionsJson] = await Promise.all([
      Promise.all(
        SOURCES.map(async (source) => {
          const extraEnv = source === "claude" ? ccusageClaudeEnv(env) : undefined;
          const json = await runCcusageBinary(bin, [source, "daily", "--json", "--offline"], extraEnv);
          return { source, mapped: json ? mapCcusageDaily(source, json) : [] };
        }),
      ),
      runCcusageBinary(bin, ["session", "--json", "--offline"]),
    ]);
    for (const { source, mapped } of results) {
      bySource.set(source, mapped);
      if (mapped.length > 0) toolsFound.push(source);
    }
    sessions = sessionsJson ? mapCcusageSessions(sessionsJson) : [];
  }

  const cursor = await cursorTask;
  if (cursor.found) toolsFound.push("cursor");
  toolsFound = [...new Set(toolsFound)];
  return { bySource, cursor: cursor.entries, sessions, toolsFound };
}

/** Merge the two tiers into the final deduped entry set (native wins for claude/codex). */
export function mergeTiers(native: NativeTier, slow: SlowTier | null): DailyUsageEntry[] {
  const nativePick = { claude: native.claude, codex: native.codex };
  const merged: DailyUsageEntry[] = [...native.others];
  const sources = new Set<string>([...(slow?.bySource.keys() ?? []), "claude", "codex"]);
  for (const source of sources) {
    merged.push(...selectSourceEntries(source, slow?.bySource.get(source) ?? [], nativePick));
  }
  merged.push(...(slow?.cursor ?? []));
  return dedupeDaily(merged);
}

/**
 * Map Claude transcript uuid -> human project name. ccusage's session ids are
 * bare transcript uuids; the PROJECT lives in the transcript's parent dir name
 * (~/.claude/projects/<cwd-slug>/<uuid>.jsonl, slug = cwd with "/" -> "-").
 * Directory listing only — no file reads, safe to run per snapshot.
 */
export function claudeSessionNames(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const names = new Map<string, string>();
  for (const root of resolveClaudeProjectDirs(env)) {
    let projects: string[];
    try {
      projects = readdirSync(root);
    } catch {
      continue;
    }
    for (const project of projects) {
      const label = project.split("-").filter(Boolean).slice(-2).join("/") || project;
      let files: string[];
      try {
        files = readdirSync(join(root, project));
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith(".jsonl")) names.set(f.slice(0, -6), label);
      }
    }
  }
  return names;
}
