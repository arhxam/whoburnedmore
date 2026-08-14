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
import type { SubmitPayload, SubmitResponse } from "../../../src/shared.js";
import { join } from "node:path";

import {
  capByTokens,
  codexReplayCorrectionMetadata,
} from "../../../src/collect.js";
import {
  sanitizeCodexReplayScopes,
  sanitizeDailyEntries,
} from "../../../src/wire-sanitize.js";
import { refreshCliToken, submit, UnauthorizedError } from "../../../src/api.js";
import {
  deviceKeyHash,
  loadConfig,
  recordSync,
  saveAuth,
} from "../../../src/config.js";
import { collectCodexNative } from "../../../src/native/codex.js";

import {
  burnbarCacheDir,
  collectNativeTier,
  collectSlowTier,
  mergeTiers,
} from "./collector.js";

const SIDECAR_CLI_VERSION = "burnbar-0.8.0";

function syncConfig(env: NodeJS.ProcessEnv) {
  return loadConfig(env.WHOBURNEDMORE_CONFIG_DIR);
}

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
  options: { nativeOnly?: boolean } = {},
): Promise<SubmitPayload> {
  // Automatic live updates run up to twice a minute. Their watched providers
  // are already covered by the fast native tier, so do not repeatedly launch
  // the multi-source ccusage/network collector. Explicit Sync now keeps the
  // full tier below for long-tail completeness.
  const [native, slow] = await Promise.all([
    collectNativeTier(env),
    options.nativeOnly
      ? Promise.resolve(null)
      : collectSlowTier(env).catch(() => null),
  ]);
  // This slow result was collected in the same explicit-sync cycle, so it is
  // newer than a throttled fast-cache hit. Watch mode does not set this option:
  // there the latest filesystem-triggered native result must beat retained slow
  // state from an earlier timer cycle.
  const mergedEntries = mergeTiers(native, slow, { preferSlowCodex: true });
  const entries = sanitizeDailyEntries(mergedEntries);
  const cappedEntries = capByTokens(entries, 20000, tokensOf);

  // The published Codex rows are replay-aware. A separate cached native pass
  // reconstructs exactly what the legacy parser would have submitted, allowing
  // the API to compare-and-swap only matching overcounted scopes. This runs on
  // explicit sync, not BurnBar's frequent watch snapshots.
  const nativeCodexProof = await collectCodexNative(env, {
    cachePath: join(burnbarCacheDir(env), "native-cache-codex-proof.json"),
  }).catch(() => ({ entries: [], found: false, filesScanned: 0, timedOut: true }));
  const replayCorrection =
    entries.length === mergedEntries.length && cappedEntries.length === entries.length
      ? codexReplayCorrectionMetadata(
          nativeCodexProof,
          cappedEntries,
          native.codexReplayAware || Boolean(slow?.succeededSources.has("codex")),
        )
      : { tombstoneDates: [], priorScopes: [] };
  const safeReplayScopes = sanitizeCodexReplayScopes(replayCorrection.priorScopes);
  const safeReplayDates = new Set(safeReplayScopes.map((scope) => scope.date));

  const payload: SubmitPayload = {
    cliVersion: SIDECAR_CLI_VERSION,
    entries: cappedEntries,
    // Same rationale as index.ts: ccusage dates usage in the machine's local
    // timezone, so the server needs this offset to bucket into the right
    // local day rather than a UTC one.
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  };
  const safeTombstones = replayCorrection.tombstoneDates.filter((date) =>
    safeReplayDates.has(date),
  );
  if (safeTombstones.length > 0)
    payload.codexReplayTombstoneDates = safeTombstones;
  if (safeReplayScopes.length > 0)
    payload.codexReplayPriorScopes = safeReplayScopes;
  const machineKey = syncConfig(env)?.anonKey;
  if (machineKey) payload.deviceKeyHash = deviceKeyHash(machineKey);
  // Keep ccusage session identifiers on-device. They can drive BurnBar's local
  // UI, but hosted sync intentionally sends no per-conversation records.
  return payload;
}

export interface SyncOptions {
  dryRun?: boolean;
  nativeOnly?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Submit as a signed-in user via `/v1/submit`, mirroring `index.ts`'s
 * `submitSignedIn`: on a 401 (expired/invalid token) try the server-issued
 * refresh once; if that fails there is no interactive fallback here (`sync`
 * is a one-shot, non-interactive command) so it reports the error instead of
 * launching a browser sign-in.
 */
async function submitWithRefresh(
  token: string,
  refreshToken: string | undefined,
  payload: SubmitPayload,
  configDir: string | undefined,
): Promise<SubmitResponse> {
  try {
    return await submit(token, payload);
  } catch (err) {
    if (err instanceof UnauthorizedError && refreshToken) {
      const healed = await refreshCliToken(refreshToken);
      if (healed) {
        saveAuth(configDir, { cliToken: healed.token, handle: healed.handle });
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
  const cfg = syncConfig(env);

  if (options.dryRun) {
    const payload = await buildSyncPayload(env, { nativeOnly: options.nativeOnly });
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          connected: Boolean(cfg?.cliToken),
          entries: payload.entries.length,
          sessions: 0,
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

  const payload = await buildSyncPayload(env, { nativeOnly: options.nativeOnly });
  if (payload.entries.length === 0) {
    console.log(JSON.stringify({ error: "no-usage" }));
    process.exitCode = 4;
    return;
  }

  let result: SubmitResponse;
  try {
    result = await submitWithRefresh(
      cfg.cliToken,
      cfg.refreshToken,
      payload,
      env.WHOBURNEDMORE_CONFIG_DIR,
    );
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
    recordSync(env.WHOBURNEDMORE_CONFIG_DIR);
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
