/**
 * Live mode: FSEvents (fs.watch recursive) on every tool's log root drives the
 * fast native tier — the per-file caches make a re-collect after one new JSONL
 * line a sub-second affair. The ccusage long-tail + Cursor API run on a slow
 * timer. Emits protocol NDJSON on stdout; reads {"cmd":...} lines on stdin.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { resolveClaudeProjectDirs } from "../../../src/native/claude.js";
import { resolveCodexSessionsDirs } from "../../../src/native/codex.js";
import { vscodeGlobalStorageRoots } from "../../../src/native/vscode-agents.js";

import { CodexLimitsReader, reconcileCodexLimits } from "./codex-limits.js";
import {
  claudeSessionNames,
  collectNativeTier,
  collectSlowTier,
  mergeTiers,
  terminateCollectorProcesses,
  type SlowTier,
} from "./collector.js";
import { fetchCursorLimits, reconcileCursorLimits } from "./cursor-limits.js";
import { ALERT_THRESHOLDS, detectAlerts, forecastLimitHit, type PercentSample } from "./forecast.js";
import { emit, PROTOCOL_VERSION, type CursorLimits, type Limits } from "./protocol.js";
import { summarize } from "./summarize.js";
import {
  FixedWindowCoalescer,
  shouldForceLimitDiscovery,
  stableSummarySignature,
  watchIntervals,
} from "./watch-policy.js";

export function watchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const targets = [
    ...resolveClaudeProjectDirs(env),
    ...resolveCodexSessionsDirs(env),
    ...vscodeGlobalStorageRoots(env),
    join(env.HOME ?? homedir(), ".continue", "dev_data"),
  ];
  // A provider often creates `projects/`, `sessions/`, or `dev_data/` only
  // when its first conversation starts. Watching only those leaf directories
  // means BurnBar, once launched earlier, never sees that first live session.
  // Fall back one level to the provider-owned config directory so creation of
  // the leaf is observable without recursively watching the user's whole home.
  const roots = targets.flatMap((target) => {
    if (existsSync(target)) return [target];
    const parent = dirname(target);
    return parent !== target && existsSync(parent) ? [parent] : [];
  });
  return [...new Set(roots)];
}

export async function runWatch(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  emit({ type: "hello", version: PROTOCOL_VERSION, pid: process.pid });
  const intervals = watchIntervals(env);
  const codexLimitReader = new CodexLimitsReader(env);

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
  let lastCodexSampleAt: string | null = null;
  let lastLimitsSignature: string | null = null;
  let lastSummarySignature: string | null = null;
  let lastCodexLimits: Limits["codex"] | null = null;

  const refreshLimits = (forceDiscover = false) => {
    const now = Date.now();
    const codex = reconcileCodexLimits(
      lastCodexLimits,
      codexLimitReader.read(now, forceDiscover),
      now,
    );
    if (codex.present) lastCodexLimits = codex;
    const observedPercents = [codex.primary?.usedPercent, codex.secondary?.usedPercent]
      .filter((percent): percent is number => percent !== null && percent !== undefined);
    const percent = observedPercents.length > 0 ? Math.max(...observedPercents) : null;

    // A single rate-limit payload can be observed by many 1s polls. Only feed
    // trend/alert state for a new provider observation (or our synthetic reset
    // transition), otherwise duplicate flat samples drown the real slope.
    const observationKey = `${codex.capturedAt ?? "none"}:${percent ?? "none"}`;
    if (codex.present && observationKey !== lastCodexSampleAt) {
      lastCodexSampleAt = observationKey;
      if (codex.primary?.usedPercent != null) {
        codexSamples.push({ at: now, percent: codex.primary.usedPercent });
        while (codexSamples.length > 240) codexSamples.shift();
      }
      if (percent !== null) {
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
    }
    // Re-attach the current forecast to every freshly parsed object so an
    // unchanged poll cannot make it disappear from the next emitted payload.
    if (codex.primary?.usedPercent != null) {
      const hit = forecastLimitHit(codexSamples, now);
      codex.primary.forecastHitAt = hit === null ? null : new Date(hit).toISOString();
    }

    const limits: Limits = { codex, cursor: cursorLimits };
    const signature = JSON.stringify(limits);
    if (signature !== lastLimitsSignature) {
      lastLimitsSignature = signature;
      emit({ type: "limits", limits });
    }
  };

  const collectAndEmit = async () => {
    if (collecting) {
      pending = true;
      return;
    }
    collecting = true;
    emit({ type: "status", collecting: true, lastFullCollectAt });
    try {
      // Publish cap/reset changes before any transcript aggregation awaits.
      refreshLimits();
      const native = await collectNativeTier(env);
      const entries = mergeTiers(native, slow);
      const toolsFound = [...new Set([...native.toolsFound, ...(slow?.toolsFound ?? [])])];
      const summary = summarize(
        entries,
        toolsFound,
        native.partial,
        new Date(),
        slow?.sessions ?? [],
        claudeSessionNames(env),
      );
      const signature = stableSummarySignature(summary);
      if (signature !== lastSummarySignature) {
        lastSummarySignature = signature;
        emit({ type: "snapshot", summary });
      }

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
      cursorLimits = reconcileCursorLimits(cursorLimits, await fetchCursorLimits(env));
      void collectAndEmit();
    } finally {
      slowInFlight = false;
      if (slowPending) {
        slowPending = false;
        void refreshSlow();
      }
    }
  };

  const watchers = new Map<string, FSWatcher>();
  const collectCoalescer = new FixedWindowCoalescer(
    intervals.debounceMs,
    () => void collectAndEmit(),
  );
  let limitsForceDiscover = false;
  const limitsCoalescer = new FixedWindowCoalescer(
    Math.min(250, intervals.debounceMs),
    () => {
      const forceDiscover = limitsForceDiscover;
      limitsForceDiscover = false;
      refreshLimits(forceDiscover);
    },
  );
  const codexTargets = resolveCodexSessionsDirs(env);
  const isCodexWatchRoot = (root: string) => codexTargets.some(
    (target) => target === root || target.startsWith(`${root}/`) || root.startsWith(`${target}/`),
  );
  const onFsEvent = (root: string, eventType?: string) => {
    collectCoalescer.trigger();
    if (isCodexWatchRoot(root)) {
      limitsForceDiscover ||= shouldForceLimitDiscovery(eventType);
      limitsCoalescer.trigger();
    }
  };
  const attachNewWatchers = (): boolean => {
    let added = false;
    for (const root of watchRoots(env)) {
      if (watchers.has(root)) continue;
      try {
        const w = watch(root, { recursive: true }, (eventType) => onFsEvent(root, eventType));
        watchers.set(root, w);
        added = true;
        // FSWatcher can emit 'error' AFTER creation (watched dir deleted/moved,
        // EMFILE, FSEvents failure). Drop the root and let the rescan timer
        // attach again if/when the provider recreates it.
        w.on("error", () => {
          watchers.delete(root);
          try {
            w.close();
          } catch {
            /* already closed */
          }
        });
      } catch {
        /* root vanished or is not ready yet — the rescan timer will retry */
      }
    }
    return added;
  };
  attachNewWatchers();

  // Provider config roots can be created after BurnBar starts (fresh install,
  // first Codex/Claude conversation). Reconcile cheaply instead of requiring an
  // app restart; when a new root appears, collect immediately because its first
  // transcript may have been written before the watcher was attached.
  const watchRescanTimer = setInterval(() => {
    if (attachNewWatchers()) {
      refreshLimits(true);
      void collectAndEmit();
    }
  }, intervals.watchRescanMs);

  // FSEvents is a latency accelerator, not a delivery guarantee. In practice,
  // recursive watches on a large real-world transcript tree can miss an append
  // even while the active rollout's size and mtime keep advancing. The native
  // readers are persistent-cache incremental, so a 30-second safety collect
  // reads only changed active files and guarantees forward progress for every
  // provider without falling back to the five-minute slow tier or archives.
  const nativePollTimer = setInterval(() => void collectAndEmit(), intervals.nativePollMs);
  const limitsPollTimer = setInterval(() => refreshLimits(), intervals.limitsPollMs);

  const slowTimer = setInterval(() => void refreshSlow(), intervals.slowMs);
  const heartbeat = setInterval(
    () => emit({ type: "heartbeat", ts: new Date().toISOString() }),
    intervals.heartbeatMs,
  );

  const shutdown = () => {
    for (const w of watchers.values()) w.close();
    clearInterval(slowTimer);
    clearInterval(watchRescanTimer);
    clearInterval(nativePollTimer);
    clearInterval(limitsPollTimer);
    clearInterval(heartbeat);
    collectCoalescer.cancel();
    limitsCoalescer.cancel();
    terminateCollectorProcesses();
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

  // Native readers populate the UI immediately. The slower all-source tier
  // enriches it in the background instead of holding first paint hostage to a
  // slow parser or network timeout.
  void refreshSlow();
  await collectAndEmit();
  // Keep the process alive for watchers/timers.
  await new Promise(() => {});
}

export { ALERT_THRESHOLDS };
