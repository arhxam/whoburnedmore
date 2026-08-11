/**
 * Last-good provenance store.
 *
 * Why this exists: the server tells real heavy usage from fabrication using the
 * per-day `requestCount` fingerprint (distinct provider requests) and the agent
 * rollup. Both come from time-bounded local scans (the native readers and the
 * attribution scan). When a scan is partial/timed-out for a day — the launchd
 * `Background` throttling case — the native readers fall back to ccusage, which
 * cannot see request ids, so that day's fingerprint would be submitted as ZERO,
 * REGRESSING a value a prior run already established. A day that flips from
 * "thousands of real requests" to "none" looks exactly like a forgery.
 *
 * The fix: persist the best-observed per-(date, source) fingerprint (and the last
 * full agent rollup) to a small JSON file in the CLI config dir — the same dir
 * the native per-file caches live in. On a partial run we re-attach the stored
 * value rather than emit a lower one; on a full run we trust and refresh it.
 * Conservative + back-compat: with nothing stored it is a no-op, and it never
 * inflates a day beyond what a real scan actually observed.
 */
import { join } from "node:path";
import type { AgentStat, DailyUsageEntry } from "./shared.js";
import { defaultConfigDir } from "./config.js";
import { readTextFileSyncCapped, writePrivateFileAtomic } from "./safe-local-file.js";

const MAX_PROVENANCE_STORE_BYTES = 4 * 1024 * 1024;

/** Bump when the store shape changes — a mismatched version is ignored (rebuilt). */
export const PROVENANCE_STORE_VERSION = 1;

export interface ProvenanceStore {
  v: number;
  /** `${date}|${tool}` -> best-observed requestCount total for that day+source. */
  req: Record<string, number>;
  /** Last full-snapshot agent rollup (re-attached when a later scan is partial). */
  agent?: AgentStat;
}

const KEY_SEP = "|";
const keyOf = (date: string, tool: string): string => `${date}${KEY_SEP}${tool}`;

/** Total of an entry's four token fields (which day+source row is "heaviest"). */
function entryTokens(e: DailyUsageEntry): number {
  return (
    e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
  );
}

/**
 * On-disk path for the store, in the same config dir the native per-file caches
 * use. Honors WHOBURNEDMORE_CONFIG_DIR (which the background sync forwards in its
 * plist) so interactive and background runs share one store; tests pass a temp
 * dir via that env so the real store is never touched.
 */
export function provenanceStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WHOBURNEDMORE_CONFIG_DIR?.trim();
  const dir = override || defaultConfigDir();
  return join(dir, "native-cache-provenance.json");
}

/** Load the store, or null if missing/corrupt/version-mismatched (never throws). */
export function loadProvenanceStore(path: string): ProvenanceStore | null {
  try {
    const content = readTextFileSyncCapped(path, MAX_PROVENANCE_STORE_BYTES);
    if (content === null) return null;
    const parsed = JSON.parse(content) as Partial<ProvenanceStore>;
    if (
      parsed &&
      parsed.v === PROVENANCE_STORE_VERSION &&
      parsed.req &&
      typeof parsed.req === "object"
    ) {
      return {
        v: PROVENANCE_STORE_VERSION,
        req: parsed.req as Record<string, number>,
        agent: parsed.agent,
      };
    }
  } catch {
    // Missing or corrupt store: start over. Never fatal.
  }
  return null;
}

/** Persist the store atomically (best-effort; a failure is never fatal). */
export function saveProvenanceStore(path: string, store: ProvenanceStore): void {
  try {
    writePrivateFileAtomic(path, JSON.stringify(store), MAX_PROVENANCE_STORE_BYTES);
  } catch {
    // Best-effort: the run still submits correct data without the store.
  }
}

/**
 * Reconcile this run's daily entries + agent rollup against the last-good store.
 *
 * `complete` = this run's usage scan is a full snapshot (nothing timed out). On a
 * full run the entries/agent are authoritative: refresh the store from them (a
 * legitimate decrease is allowed) and pass them through unchanged. On a partial
 * run: never let a day+source's `requestCount` go BELOW its stored best — bump
 * the day's heaviest row to make up the deficit — and re-attach the stored agent
 * rollup when it's richer than the partial one. With an empty store it's a no-op.
 *
 * Pure: returns the entries/agent to emit and the store to persist; the caller
 * does the IO. Never fabricates a row (a stored day with no row this run is left
 * alone) and never inflates beyond an observed value.
 */
export function reconcileProvenance(
  entries: DailyUsageEntry[],
  agent: AgentStat,
  complete: boolean,
  store: ProvenanceStore | null,
): { entries: DailyUsageEntry[]; agent: AgentStat; store: ProvenanceStore } {
  const prevReq = store?.req ?? {};
  const prevAgent = store?.agent;

  // This run's per-(date, source) fingerprint, counting only rows that CARRY a
  // requestCount (native-reader rows). ccusage-fallback rows omit it entirely.
  const curReq = new Map<string, number>();
  for (const e of entries) {
    if (e.requestCount === undefined) continue;
    const k = keyOf(e.date, e.tool);
    curReq.set(k, (curReq.get(k) ?? 0) + e.requestCount);
  }

  const nextReq: Record<string, number> = { ...prevReq };
  let outEntries = entries;

  if (complete) {
    // Authoritative snapshot: record exactly what we fingerprinted this run
    // (allowing a legit decrease). Days we didn't fingerprint keep their prior
    // last-good rather than being wiped.
    for (const [k, v] of curReq) nextReq[k] = v;
  } else {
    // Partial run: keep the max so a stored best is never lowered by a partial.
    for (const [k, v] of curReq) nextReq[k] = Math.max(prevReq[k] ?? 0, v);

    // Heaviest row per (date, source) carries any restored deficit.
    const heaviest = new Map<string, DailyUsageEntry>();
    for (const e of entries) {
      const k = keyOf(e.date, e.tool);
      const cur = heaviest.get(k);
      if (!cur || entryTokens(e) > entryTokens(cur)) heaviest.set(k, e);
    }
    let cloned: DailyUsageEntry[] | null = null;
    for (const [k, stored] of Object.entries(prevReq)) {
      const cur = curReq.get(k) ?? 0;
      if (stored <= cur) continue; // no regression to correct
      const target = heaviest.get(k);
      if (!target) continue; // no row for that day+source this run — don't fabricate
      if (!cloned) cloned = [...entries];
      const idx = cloned.indexOf(target);
      cloned[idx] = {
        ...target,
        requestCount: (target.requestCount ?? 0) + (stored - cur),
      };
    }
    if (cloned) outEntries = cloned;
  }

  // Agent rollup: persist a full snapshot; on a partial run re-attach the stored
  // rollup when it's richer (more total tokens) than the partial one.
  let outAgent = agent;
  let nextAgent = prevAgent;
  if (complete && agent.messageCount > 0) {
    nextAgent = agent;
  } else if (!complete && prevAgent && prevAgent.totalTokens > agent.totalTokens) {
    outAgent = prevAgent;
  }

  return {
    entries: outEntries,
    agent: outAgent,
    store: { v: PROVENANCE_STORE_VERSION, req: nextReq, agent: nextAgent },
  };
}
