/**
 * `burnbar-sidecar sync` — one-shot manual submit to whoburnedmore. Runs the
 * same collection pipeline as `snapshot` (native + slow tier, merged), plus
 * the ccusage session rollup already fetched by the slow tier, assembled into
 * the same `SubmitPayload` shape `src/index.ts` builds after
 * `collectAll()`, and posted via the CLI's authenticated `/v1/submit` path
 * (`src/api.ts#submit`). BurnBar never has its own separate
 * sign-in — it reuses the CLI's stored config
 * (`~/.config/whoburnedmore/config.json`, via `src/config.ts`),
 * so `sync` only works on a machine where `npx whoburnedmore` has already
 * signed in (or been `link`ed).
 *
 * blocks/tools/skills/agent (attribution) are intentionally NOT collected
 * here — they require `collectAttribution()`'s transcript scan, which the
 * sidecar's two-tier collector doesn't run, and the server payload schema
 * makes all of them optional. Adding them would duplicate a chunk of
 * `collectAll()`'s orchestration for a one-shot manual command; entries +
 * sessions are the meaningful board-moving fields.
 */
import type { SessionEntry, SubmitPayload, SubmitResponse } from "../../../src/shared.js";

import { capByTokens, dedupeSessions } from "../../../src/collect.js";
import { refreshCliToken, submit, UnauthorizedError } from "../../../src/api.js";
import { loadConfig, recordSync, saveAuth } from "../../../src/config.js";

import { collectNativeTier, collectSlowTier, mergeTiers } from "./collector.js";

const SIDECAR_CLI_VERSION = "burnbar-0.1.0";

function tokensOf(e: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
}

/** Collect + assemble the exact payload a real submit would send. Shared by
 *  both the real submit and `--dry-run` (so the dry-run count is honest). */
export async function buildSyncPayload(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubmitPayload> {
  const [native, slow] = await Promise.all([
    collectNativeTier(env),
    collectSlowTier(env).catch(() => null),
  ]);
  const entries = mergeTiers(native, slow);
  const cappedEntries = capByTokens(entries, 20000, tokensOf);

  const sessions: SessionEntry[] = dedupeSessions(slow?.sessions ?? []);
  const cappedSessions = capByTokens(sessions, 10000, tokensOf);

  const payload: SubmitPayload = {
    cliVersion: SIDECAR_CLI_VERSION,
    entries: cappedEntries,
    // Same rationale as index.ts: ccusage dates usage in the machine's local
    // timezone, so the server needs this offset to bucket into the right
    // local day rather than a UTC one.
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  };
  if (cappedSessions.length > 0) payload.sessions = cappedSessions;
  return payload;
}

export interface SyncOptions {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Submit as a signed-in user via `/v1/submit`, mirroring `index.ts`'s
 * `submitSignedIn`: on a 401 (expired/invalid token) try the silent device-key
 * refresh once; if that fails there is no interactive fallback here (`sync`
 * is a one-shot, non-interactive command) so it reports the error instead of
 * launching a browser sign-in.
 */
async function submitWithRefresh(
  token: string,
  anonKey: string | undefined,
  payload: SubmitPayload,
): Promise<SubmitResponse> {
  try {
    return await submit(token, payload);
  } catch (err) {
    if (err instanceof UnauthorizedError && anonKey) {
      const healed = await refreshCliToken(anonKey);
      if (healed) {
        saveAuth(undefined, { cliToken: healed.token, handle: healed.handle });
        return submit(healed.token, payload);
      }
    }
    throw err;
  }
}

/**
 * Run `sync`: collect, assemble the payload, and either print it (--dry-run)
 * or submit it and print a compact result. Never throws — every failure path
 * prints a JSON error object and sets `process.exitCode` instead.
 */
export async function runSync(options: SyncOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const cfg = loadConfig();

  if (options.dryRun) {
    const payload = await buildSyncPayload(env);
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          connected: Boolean(cfg?.cliToken),
          entries: payload.entries.length,
          sessions: payload.sessions?.length ?? 0,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!cfg?.cliToken) {
    console.log(JSON.stringify({ error: "not-connected" }));
    process.exitCode = 3;
    return;
  }

  const payload = await buildSyncPayload(env);
  if (payload.entries.length === 0) {
    console.log(JSON.stringify({ error: "no-usage" }));
    process.exitCode = 4;
    return;
  }

  let result: SubmitResponse;
  try {
    result = await submitWithRefresh(cfg.cliToken, cfg.anonKey, payload);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      console.log(JSON.stringify({ error: "unauthorized" }));
      process.exitCode = 3;
      return;
    }
    console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
    return;
  }

  try {
    recordSync();
  } catch {
    /* best-effort — never fail an already-good submit over a freshness stamp */
  }

  console.log(
    JSON.stringify(
      {
        rank: result.rank,
        totalTokens: result.totalTokens,
        totalCostUSD: result.totalCostUSD,
        profileUrl: result.profileUrl,
      },
      null,
      2,
    ),
  );
}
