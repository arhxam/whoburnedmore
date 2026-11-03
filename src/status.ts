import {
  autoSyncDrift,
  autoSyncInstalled,
  autoSyncLoaded,
  resolveNodePath,
  SYNC_INTERVAL_MINUTES,
  syncIntervalLabel,
  syncLogPath,
  type DriftState,
} from "./autosync.js";
import { loadConfig } from "./config.js";
import { statusSignedInLine } from "./output.js";

export interface StatusInput {
  installed: boolean;
  loaded: boolean;
  drift: DriftState;
  intervalMinutes: number;
  lastSyncAt: number | null;
  now: number;
  nodePath: string;
  /** Stable (survives `brew upgrade node`) vs a version-pinned Cellar path. */
  nodePathStable: boolean;
  logPath: string;
  /** Handle when a CLI token is stored. Null when this machine is signed out.
   *  Empty string means signed in with no handle on file. */
  signedInAs: string | null;
}

function ago(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Build the `status` report as plain lines (no color), so it's unit-testable.
 * Data is considered STALE when there's no recorded sync yet, or the last sync is
 * older than ~2× the configured interval (one missed tick is normal; two is not).
 */
export function buildStatusReport(s: StatusInput): string[] {
  const lines: string[] = [];
  lines.push("  whoburnedmore — background sync status");
  lines.push("");
  lines.push(statusSignedInLine(s.signedInAs));

  lines.push(
    s.installed
      ? `  • Background agent: installed${s.loaded ? " and loaded" : " but NOT loaded with the scheduler"}`
      : "  • Background agent: NOT installed — run `npx whoburnedmore` to set it up",
  );
  if (s.installed && s.drift !== "ok") {
    lines.push(
      "    ↳ config is out of date — it will self-repair on your next run",
    );
  }
  lines.push(`  • Interval: every ${syncIntervalLabel(s.intervalMinutes)}`);

  const staleAfterMs = s.intervalMinutes * 2 * 60 * 1000;
  if (s.lastSyncAt === null) {
    lines.push("  • Last sync: never recorded");
    lines.push("  ⚠ STALE: no successful sync recorded yet — run `npx whoburnedmore`");
  } else {
    const age = s.now - s.lastSyncAt;
    lines.push(`  • Last sync: ${ago(age)}`);
    if (age > staleAfterMs) {
      lines.push(
        `  ⚠ STALE: last sync was over ${syncIntervalLabel(s.intervalMinutes * 2)} ago — your dashboard may be behind. Run \`npx whoburnedmore\`.`,
      );
    } else {
      lines.push("  ✓ Fresh — your dashboard is up to date.");
    }
  }

  lines.push(`  • Node: ${s.nodePath}`);
  if (!s.nodePathStable) {
    lines.push(
      "    ⚠ that node path is version-pinned and may break on a node upgrade — a run will re-point it to a stable path",
    );
  }
  lines.push(`  • Log: ${s.logPath}`);
  return lines;
}

/** Gather real status inputs from this machine and build the report. */
export function agentStatusReport(now: number = Date.now()): string[] {
  const cfg = loadConfig();
  const nodePath = resolveNodePath();
  return buildStatusReport({
    installed: autoSyncInstalled(),
    loaded: autoSyncLoaded(),
    drift: autoSyncDrift(),
    intervalMinutes: SYNC_INTERVAL_MINUTES,
    lastSyncAt: typeof cfg?.lastSyncAt === "number" ? cfg.lastSyncAt : null,
    now,
    nodePath,
    nodePathStable: !nodePath.includes("/Cellar/"),
    logPath: syncLogPath(),
    signedInAs: cfg?.cliToken ? (cfg.handle ?? "") : null,
  });
}
