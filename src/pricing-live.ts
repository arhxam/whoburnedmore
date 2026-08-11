/**
 * Live pricing for the CLI — ccusage's "auto" cost mode equivalent.
 *
 * Once per day we fetch LiteLLM's pricing database (the same source ccusage
 * uses), transform it to our compact table, and cache it under the config
 * dir. Every collection run merges that table over the baked snapshot, so an
 * already-installed CLI picks up new models and price changes without a
 * republish. Everything here is best-effort: on any failure (offline, slow
 * network, corrupt cache) we fall back to a stale cache, then to the baked
 * snapshot — a run never fails or blocks long because of pricing.
 */
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  LITELLM_PRICING_URL,
  litellmToTable,
  setLivePricing,
  type PriceRow,
} from "./shared.js";
import { defaultConfigDir } from "./config.js";
import { readJsonResponseCapped } from "./http-bounds.js";
import { readTextFileCapped } from "./native/file-cache.js";

/** How long a cached table stays fresh (LiteLLM updates a few times a week). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap on the fetch — pricing must never make a run feel slow. */
const FETCH_TIMEOUT_MS = 5_000;
const MAX_PRICING_BYTES = 32 * 1024 * 1024;

export type PricingSource = "live" | "cache" | "baked";

interface CacheFile {
  fetchedAt: number;
  table: Record<string, PriceRow>;
}

export function pricingCachePath(dir = defaultConfigDir()): string {
  return join(dir, "pricing-cache.json");
}

async function readCache(path: string): Promise<CacheFile | null> {
  try {
    const read = await readTextFileCapped(path, { maxBytes: MAX_PRICING_BYTES });
    if (!read.ok) return null;
    const parsed = JSON.parse(read.content) as CacheFile;
    if (
      typeof parsed?.fetchedAt === "number" &&
      parsed.table &&
      typeof parsed.table === "object"
    ) {
      return parsed;
    }
  } catch {
    // missing or corrupt cache — treat as absent
  }
  return null;
}

async function fetchLiveTable(
  url: string,
): Promise<Record<string, PriceRow> | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) return null;
    const table = litellmToTable(await readJsonResponseCapped(res, MAX_PRICING_BYTES));
    return Object.keys(table).length > 0 ? table : null;
  } catch {
    return null;
  }
}

/**
 * Load the freshest pricing available and install it as the active table.
 * Returns where the rates came from (for `doctor`/debug output). Set
 * WHOBURNEDMORE_PRICING_OFFLINE=1 to skip the network entirely.
 */
export async function loadLivePricing(
  env = process.env,
  now: () => number = Date.now,
  cachePath = pricingCachePath(),
): Promise<PricingSource> {
  if (env.WHOBURNEDMORE_PRICING_OFFLINE) return "baked";

  const path = cachePath;
  const cached = await readCache(path);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) {
    setLivePricing(cached.table);
    return "cache";
  }

  const live = await fetchLiveTable(env.WHOBURNEDMORE_PRICING_URL ?? LITELLM_PRICING_URL);
  if (live) {
    setLivePricing(live);
    try {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      // Write-then-rename so a concurrent run (foreground + background sync)
      // can never read a torn half-written cache.
      const serialized = JSON.stringify({ fetchedAt: now(), table: live });
      if (Buffer.byteLength(serialized, "utf8") <= MAX_PRICING_BYTES) {
        const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          await writeFile(tmp, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
          await chmod(tmp, 0o600);
          await rename(tmp, path);
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
      }
    } catch {
      // cache write is best-effort; live rates are already active
    }
    return "live";
  }

  if (cached) {
    // Stale beats baked: even a week-old LiteLLM table is newer than the
    // snapshot compiled into this binary.
    setLivePricing(cached.table);
    return "cache";
  }
  return "baked";
}
