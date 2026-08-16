/**
 * BurnBar's collection orchestrator. Mirrors the CLI collectAll() but is
 * compiled-binary-safe: collectAll resolves the ccusage JS bin through
 * require.resolve, which cannot work inside a bun single-file executable, so we
 * re-orchestrate here and spawn the standalone ccusage PLATFORM BINARY instead
 * (shipped in BurnBar.app/Contents/Resources, path via BURNBAR_CCUSAGE).
 *
 * Two tiers:
 *  - collectNative(): the fast, file-watch-driven tier — Claude Code, Cline,
 *    Roo, Continue via native readers, plus Codex via the bundled replay-aware
 *    ccusage binary (native Codex is diagnostic-only and never published).
 *  - collectSlow(): the long-tail tier on a timer — every ccusage source plus
 *    the Cursor dashboard API (network) — merged over the latest native tier.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DailyUsageEntry, SessionEntry } from "../../../src/shared.js";

import {
  CCUSAGE_MAX_CONCURRENCY,
  mapConcurrent,
  SOURCES,
  ccusageClaudeEnv,
  dedupeDaily,
  mapCcusageDaily,
  mapCcusageSessions,
  resolveCcusageBin,
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
import {
  VSCODE_AGENTS,
  collectVscodeAgent,
} from "../../../src/native/vscode-agents.js";
import { loadLivePricing } from "../../../src/pricing-live.js";

const activeCollectorProcesses = new Set<ChildProcess>();

/** Watch mode owns every parser it starts. Termination must not leave a CPU-
 * intensive ccusage scan reparented and running after the menu-bar app exits. */
export function terminateCollectorProcesses(): void {
  for (const child of activeCollectorProcesses) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

const EMPTY_NATIVE: NativeCollectResult = { entries: [], found: false, filesScanned: 0 };
type FastCodexResult = { result: NativeCollectResult; replayAware: boolean };
const fastCodexCache = new Map<string, { at: number; value: FastCodexResult }>();

function fastCodexCacheKey(env: NodeJS.ProcessEnv, command: CcusageCommand | null): string {
  return `${command?.cmd ?? "none"}|${env.CODEX_HOME ?? ""}`;
}

function fastCodexMinInterval(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.BURNBAR_CODEX_MIN_INTERVAL_MS ?? 30_000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
}

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
  /** True only when `codex` came from the replay-aware ccusage parser. */
  codexReplayAware: boolean;
  others: DailyUsageEntry[];
  toolsFound: string[];
  partial: boolean;
}

export async function collectNativeTier(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeTier> {
  const cacheDir = burnbarCacheDir(env);
  await loadLivePricing(env, Date.now, join(cacheDir, "pricing-cache.json")).catch(
    () => {},
  );
  const cache = (name: string) => join(cacheDir, `native-cache-${name}.json`);

  const [claude, fastCodex, cont, ...vscode] = await Promise.all([
    collectClaudeNative(env, { cachePath: cache("claude") }).catch(() => EMPTY_NATIVE),
    collectFastCodex(env),
    collectContinue({ env, cachePath: cache("continue") }).catch(() => EMPTY_NATIVE),
    ...VSCODE_AGENTS.map((a) =>
      collectVscodeAgent({ tool: a.tool, extIds: a.extIds, env, cachePath: cache(`vscode-${a.tool}`) }).catch(
        () => EMPTY_NATIVE,
      ),
    ),
  ]);
  const { result: codex, replayAware: codexReplayAware } = fastCodex;

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
    codexReplayAware,
    others: [...cont.entries, ...vscode.flatMap((r) => r.entries)],
    toolsFound,
    partial: [claude, codex, cont, ...vscode].some((r) => r.timedOut === true),
  };
}

export interface SlowTier {
  /** ccusage entries per source (claude/codex included as fallback candidates). */
  bySource: Map<string, DailyUsageEntry[]>;
  /** Sources whose parser completed successfully, including valid empty results. */
  succeededSources: Set<string>;
  cursor: DailyUsageEntry[];
  /** ccusage `session` rollup (aggregate per-conversation totals). */
  sessions: SessionEntry[];
  toolsFound: string[];
}

interface CcusageCommand {
  cmd: string;
  prefixArgs: string[];
}

/** Locate ccusage: bundled standalone override in-app, workspace dependency in development. */
export function resolveCcusageStandalone(
  env: NodeJS.ProcessEnv = process.env,
): CcusageCommand | null {
  if (env.BURNBAR_CCUSAGE) return { cmd: env.BURNBAR_CCUSAGE, prefixArgs: [] };
  try {
    return resolveCcusageBin();
  } catch {
    return null;
  }
}

async function runCcusageBinary(
  command: CcusageCommand,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<unknown | null> {
  return await new Promise((resolve) => {
    const child = execFile(
      command.cmd,
      [...command.prefixArgs, ...args],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 25_000,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (error, stdout) => {
        activeCollectorProcesses.delete(child);
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(stdout ? JSON.parse(stdout) : null);
        } catch {
          resolve(null);
        }
      },
    );
    activeCollectorProcesses.add(child);
  });
}

/**
 * BurnBar needs a correct Codex number on its first, file-watch-driven snapshot,
 * not only after the slower all-source refresh. The bundled ccusage Codex reader
 * removes replayed parent prefixes from forked/subagent rollouts. If that binary
 * is unavailable or transiently fails, return no Codex rows. The native reader
 * intentionally omits fork/subagent rollouts, so publishing it could turn a
 * partial snapshot into an irreversible downward API correction.
 */
async function collectFastCodex(
  env: NodeJS.ProcessEnv,
): Promise<FastCodexResult> {
  const command = resolveCcusageStandalone(env);
  const cacheKey = fastCodexCacheKey(env, command);
  const cached = fastCodexCache.get(cacheKey);
  if (cached && Date.now() - cached.at < fastCodexMinInterval(env)) return cached.value;
  let value: FastCodexResult = { result: EMPTY_NATIVE, replayAware: false };
  if (command) {
    const json = await runCcusageBinary(
      command,
      ["codex", "daily", "--json", "--offline"],
      env,
    );
    if (json !== null) {
      const entries = mapCcusageDaily("codex", json);
      value = {
        result: { entries, found: entries.length > 0, filesScanned: 0 },
        replayAware: true,
      };
    }
  }
  fastCodexCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function collectSlowTier(
  env: NodeJS.ProcessEnv = process.env,
  options: { offline?: boolean } = {},
): Promise<SlowTier> {
  const command = resolveCcusageStandalone(env);
  const bySource = new Map<string, DailyUsageEntry[]>();
  const succeededSources = new Set<string>();
  let toolsFound: string[] = [];
  let sessions: SessionEntry[] = [];

  const cursorTask = collectCursor({ offline: options.offline }).catch(() => ({
    entries: [],
    blocks: [],
    found: false,
  }));

  if (command) {
    const [results, sessionsJson] = await Promise.all([
      mapConcurrent(
        SOURCES,
        CCUSAGE_MAX_CONCURRENCY,
        async (source) => {
          const sourceEnv = source === "claude" ? ccusageClaudeEnv(env) : env;
          const json = await runCcusageBinary(
            command,
            [source, "daily", "--json", "--offline"],
            sourceEnv,
          );
          return {
            source,
            mapped: json ? mapCcusageDaily(source, json) : [],
            succeeded: json !== null,
          };
        },
      ),
      runCcusageBinary(
        command,
        ["session", "--json", "--offline"],
        ccusageClaudeEnv(env),
      ),
    ]);
    for (const { source, mapped, succeeded } of results) {
      bySource.set(source, mapped);
      if (succeeded) succeededSources.add(source);
      if (mapped.length > 0) toolsFound.push(source);
      if (source === "codex" && succeeded) {
        const command = resolveCcusageStandalone(env);
        fastCodexCache.set(fastCodexCacheKey(env, command), {
          at: Date.now(),
          value: {
            result: { entries: mapped, found: mapped.length > 0, filesScanned: 0 },
            replayAware: true,
          },
        });
      }
    }
    sessions = sessionsJson ? mapCcusageSessions(sessionsJson) : [];
  }

  const cursor = await cursorTask;
  if (cursor.found) toolsFound.push("cursor");
  toolsFound = [...new Set(toolsFound)];
  return { bySource, succeededSources, cursor: cursor.entries, sessions, toolsFound };
}

/** Merge tiers: native wins for Claude; the freshest replay-aware read wins for Codex. */
export function mergeTiers(
  native: NativeTier,
  slow: SlowTier | null,
  options: { preferSlowCodex?: boolean } = {},
): DailyUsageEntry[] {
  const nativePick = { claude: native.claude, codex: native.codex };
  const merged: DailyUsageEntry[] = [...native.others];
  const sources = new Set<string>([...(slow?.bySource.keys() ?? []), "claude", "codex"]);
  for (const source of sources) {
    // An explicit slow collection is newer than the throttled fast cache. Its
    // successful empty result is authoritative too: retaining old rows after
    // the parser says the scope is empty would visibly resurrect an overcount.
    if (
      source === "codex" &&
      options.preferSlowCodex &&
      slow?.succeededSources.has("codex")
    ) {
      merged.push(...(slow.bySource.get("codex") ?? []));
      continue;
    }
    if (source === "codex" && native.codexReplayAware) {
      merged.push(...native.codex.entries);
      continue;
    }
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
