/**
 * Live mode: FSEvents (fs.watch recursive) on every tool's log root drives the
 * fast native tier — the per-file caches make a re-collect after one new JSONL
 * line a sub-second affair. The ccusage long-tail + Cursor API run on a slow
 * timer. Emits protocol NDJSON on stdout; reads {"cmd":...} lines on stdin.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { resolveClaudeProjectDirs } from "../../../src/native/claude.js";
import { resolveCodexSessionsDir } from "../../../src/native/codex.js";
import { vscodeGlobalStorageRoots } from "../../../src/native/vscode-agents.js";

import { readCodexLimits } from "./codex-limits.js";
import {
  claudeSessionNames,
  collectNativeTier,
  collectSlowTier,
  mergeTiers,
  type SlowTier,
} from "./collector.js";
import { fetchCursorLimits } from "./cursor-limits.js";
import { ALERT_THRESHOLDS, detectAlerts, forecastLimitHit, type PercentSample } from "./forecast.js";
import { emit, PROTOCOL_VERSION, type CursorLimits, type Limits } from "./protocol.js";
import { summarize } from "./summarize.js";

const DEBOUNCE_MS = Number(process.env.BURNBAR_DEBOUNCE_MS ?? 1500);
const SLOW_INTERVAL_MS = Number(process.env.BURNBAR_SLOW_INTERVAL_MS ?? 5 * 60 * 1000);
const HEARTBEAT_MS = 30_000;

export function watchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [
    ...resolveClaudeProjectDirs(env),
    resolveCodexSessionsDir(env),
    ...vscodeGlobalStorageRoots(env),
    join(env.HOME ?? homedir(), ".continue", "dev_data"),
  ];
  return [...new Set(roots)].filter((r) => existsSync(r));
}

export async function runWatch(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  emit({ type: "hello", version: PROTOCOL_VERSION, pid: process.pid });

  let slow: SlowTier | null = null;
  let cursorLimits: CursorLimits = {
    present: false,
    planPercent: null,
    used: null,
    limit: null,
    renewsAt: null,
  };
  let lastFullCollectAt: string | null = null;
  let collecting = false;
  let pending = false;
  let prevCodexPercent: number | null = null;
  const codexSamples: PercentSample[] = [];

  const collectAndEmit = async () => {
    if (collecting) {
      pending = true;
      return;
    }
    collecting = true;
    emit({ type: "status", collecting: true, lastFullCollectAt });
    try {
      const native = await collectNativeTier(env);
      const entries = mergeTiers(native, slow);
      const toolsFound = [...new Set([...native.toolsFound, ...(slow?.toolsFound ?? [])])];
      emit({
        type: "snapshot",
        summary: summarize(entries, toolsFound, native.partial, new Date(), slow?.sessions ?? [], claudeSessionNames(env)),
      });

      const codex = readCodexLimits(env);
      const now = Date.now();
      if (codex.present && codex.primary?.usedPercent != null) {
        const percent = codex.primary.usedPercent;
        codexSamples.push({ at: now, percent });
        while (codexSamples.length > 240) codexSamples.shift();
        const hit = forecastLimitHit(codexSamples, now);
        codex.primary.forecastHitAt = hit === null ? null : new Date(hit).toISOString();
        for (const alert of detectAlerts(prevCodexPercent, percent)) {
          emit({
            type: "alert",
            kind: alert.kind,
            provider: "codex",
            ...(alert.level !== undefined ? { level: alert.level } : {}),
            percent: alert.percent,
          });
        }
        prevCodexPercent = percent;
      }
      const limits: Limits = { codex, cursor: cursorLimits };
      emit({ type: "limits", limits });
      lastFullCollectAt = new Date().toISOString();
      emit({ type: "status", collecting: false, lastFullCollectAt });
    } catch (err) {
      emit({
        type: "status",
        collecting: false,
        lastFullCollectAt,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      collecting = false;
      if (pending) {
        pending = false;
        void collectAndEmit();
      }
    }
  };

  // Slow tier first so the first snapshot already has the long tail when cheap.
  // Cursor plan limits ride the same slow cadence (network call) — never on
  // every FS event.
  // Re-entrancy guard (like collectAndEmit): the slow tier is triggered from the
  // initial call, the interval, AND the stdin "refresh" command, each taking up
  // to ~25s. Without this, two overlapping runs let the slower one finish last
  // and clobber the newer results (last-write-wins race).
  let slowInFlight = false;
  let slowPending = false;
  const refreshSlow = async () => {
    if (slowInFlight) {
      slowPending = true;
      return;
    }
    slowInFlight = true;
    try {
      try {
        slow = await collectSlowTier(env);
      } catch {
        /* keep previous slow tier */
      }
      cursorLimits = await fetchCursorLimits(env);
      void collectAndEmit();
    } finally {
      slowInFlight = false;
      if (slowPending) {
        slowPending = false;
        void refreshSlow();
      }
    }
  };

  const watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onFsEvent = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void collectAndEmit(), DEBOUNCE_MS);
  };
  for (const root of watchRoots(env)) {
    try {
      const w = watch(root, { recursive: true }, onFsEvent);
      // FSWatcher can emit 'error' AFTER creation (watched dir deleted/moved,
      // EMFILE, FSEvents failure). With no listener, Node's EventEmitter throws
      // and kills the whole sidecar. Drop the root instead — the slow timer covers it.
      w.on("error", () => {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      });
      watchers.push(w);
    } catch {
      /* root vanished or unwatchable — the slow timer still covers it */
    }
  }

  const slowTimer = setInterval(() => void refreshSlow(), SLOW_INTERVAL_MS);
  const heartbeat = setInterval(
    () => emit({ type: "heartbeat", ts: new Date().toISOString() }),
    HEARTBEAT_MS,
  );

  const shutdown = () => {
    for (const w of watchers) w.close();
    clearInterval(slowTimer);
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    try {
      const cmd = (JSON.parse(line) as { cmd?: string }).cmd;
      if (cmd === "refresh") void refreshSlow();
      else if (cmd === "quit") shutdown();
    } catch {
      /* ignore garbage on stdin */
    }
  });
  rl.on("close", shutdown); // Swift died → don't linger as an orphan

  await refreshSlow();
  // Keep the process alive for watchers/timers.
  await new Promise(() => {});
}

export { ALERT_THRESHOLDS };
