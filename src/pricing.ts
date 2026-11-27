/**
 * Canonical model pricing for the whole pipeline (CLI + API import THIS module;
 * the old per-package tables drifted apart and went stale).
 *
 * Source of truth: LiteLLM's community-maintained
 * `model_prices_and_context_window.json` — the same database ccusage uses for
 * its cost calculation. Two layers:
 *
 *   1. A BAKED snapshot (`pricing-data.generated.ts`, regenerated with
 *      `node scripts/gen-pricing.mjs`) so everything works fully offline.
 *   2. An optional LIVE table merged over it at runtime (`setLivePricing`) —
 *      the API refreshes on a TTL and the CLI keeps a 24h disk cache, so new
 *      models/prices land without a redeploy or npm republish.
 *
 * Lookup is exact-id first (661+ models incl. dated ids), with progressive
 * normalization (gateway prefixes, date suffixes) and a small family-tier
 * fallback for models that are recognizable but not yet in the table.
 * Unknown models price to $0 — never a guess.
 */
import { MODEL_PRICES, type PriceRow } from "./pricing-data.generated.js";

export { PRICING_GENERATED_AT } from "./pricing-data.generated.js";
export type { PriceRow } from "./pricing-data.generated.js";

/** USD per 1M tokens for the four billing buckets. */
export interface ModelPrice {
  in: number;
  out: number;
  /** Cache write at the default (5-minute) TTL. */
  cacheWrite: number;
  cacheRead: number;
  /**
   * Cache write at the 1-hour TTL (2x input on Anthropic, vs 1.25x for 5m).
   * Claude Code writes almost all of its cache at the 1h TTL. Equals
   * `cacheWrite` when the table carries no separate 1h rate.
   */
  cacheWrite1h: number;
}

export interface PricingTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /**
   * The part of `cacheCreationTokens` written at the 1-hour TTL (Anthropic's
   * `usage.cache_creation.ephemeral_1h_input_tokens`). Optional: when absent,
   * every cache write is priced at the 5-minute rate.
   */
  cacheCreation1hTokens?: number;
}

/**
 * Highest blended USD per 1M tokens the API accepts on one uploaded row; a
 * single row above it rejects the WHOLE upload. Shared so the CLI can keep
 * its rows under the same line the server enforces.
 */
export const MAX_USD_PER_MTOK = 200;

/** The raw LiteLLM pricing JSON that ccusage also consumes. */
export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Family fallbacks for models we can recognize but that aren't in the table
 * yet (a brand-new snapshot id, a vendor alias). Rates mirror the current
 * generation of each family (~2026-06); exact ids in the table always win.
 */
const FALLBACK_TIERS: Array<{ match: RegExp; row: PriceRow }> = [
  { match: /fable/i, row: [10, 50, 12.5, 1] },
  { match: /opus/i, row: [5, 25, 6.25, 0.5] },
  { match: /sonnet/i, row: [3, 15, 3.75, 0.3] },
  { match: /haiku/i, row: [1, 5, 1.25, 0.1] },
  { match: /gpt-4o|gpt-4\.1/i, row: [2.5, 10, 2.5, 1.25] },
  { match: /gpt-5|o[134](-|$)|codex/i, row: [1.25, 10, 1.25, 0.125] },
  { match: /gemini.*flash/i, row: [0.3, 2.5, 0.3, 0.03] },
  { match: /gemini/i, row: [2, 12, 2, 0.2] },
  { match: /grok/i, row: [3, 15, 3, 0.75] },
  { match: /deepseek/i, row: [0.28, 0.42, 0.28, 0.028] },
  { match: /kimi|moonshot/i, row: [0.6, 2.5, 0.6, 0.15] },
  { match: /glm/i, row: [0.6, 2.2, 0.6, 0.11] },
  { match: /qwen/i, row: [0.4, 1.2, 0.4, 0.08] },
  { match: /mistral|codestral|devstral/i, row: [0.4, 2, 0.4, 0.1] },
  { match: /llama/i, row: [0.2, 0.6, 0.2, 0.05] },
];

/** Live (runtime-fetched) rates; consulted before the baked snapshot. */
let liveTable: Record<string, PriceRow> | null = null;

/**
 * Memoized resolutions — hot paths (submit validation per entry, profile
 * aggregation per row) resolve the same handful of models over and over, and
 * a miss walks normalization + several lookups + the fallback regexes. Keyed
 * by the RAW model string; bounded because model strings arrive from user
 * submissions (a hostile payload of unique names must not grow memory).
 */
const resolveCache = new Map<string, ModelPrice | null>();
const RESOLVE_CACHE_MAX = 10_000;

/**
 * Install a live pricing table (our compact shape — see `litellmToTable`).
 * Pass null to revert to the baked snapshot only. Returns the model count.
 */
export function setLivePricing(table: Record<string, PriceRow> | null): number {
  liveTable = table && Object.keys(table).length > 0 ? table : null;
  resolveCache.clear(); // resolutions may differ under the new table
  return liveTable ? Object.keys(liveTable).length : 0;
}

/** Round a per-token USD rate to a per-1M rate. */
function perM(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

const LITELLM_MODES = new Set(["chat", "responses", "completion"]);

/**
 * Which provider's row wins when several keys normalize to the same model
 * name. Model VENDORS come first — their row is the list price; gateways
 * (Bedrock regions, Azure, OpenRouter, resellers) bill markups and must never
 * shadow it. Mirrors scripts/gen-pricing.mjs (keep in sync).
 */
const LIVE_PROVIDER_RANK = [
  "anthropic",
  "openai",
  "gemini",
  "vertex_ai-language-models",
  "xai",
  "deepseek",
  "mistral",
  "moonshot",
];

function providerRank(provider: unknown): number {
  const i = LIVE_PROVIDER_RANK.indexOf(String(provider));
  return i === -1 ? LIVE_PROVIDER_RANK.length : i;
}

/**
 * Transform raw LiteLLM JSON into our compact table. Mirrors the build-time
 * transform in scripts/gen-pricing.mjs, minus the provider filter — at runtime
 * a bigger merged table only costs memory, and dropping the filter means a
 * model from a provider we didn't anticipate still prices correctly.
 *
 * Slot conflicts (several raw keys normalizing to one name) resolve by
 * provider rank (vendor beats gateway/region markup), then by canonical key
 * (no normalization needed), then first-seen. A losing duplicate with the SAME
 * in/out rates may still ENRICH the winner's missing cache-read pricing —
 * LiteLLM's alias rows often omit the cache fields the vendor row carries.
 */
export function litellmToTable(raw: unknown): Record<string, PriceRow> {
  const out: Record<string, PriceRow> = {};
  if (!raw || typeof raw !== "object") return out;
  /** Winner metadata per slot, for conflict resolution. */
  const meta = new Map<string, { rank: number; canonical: boolean }>();
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "sample_spec" || !v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    if (!LITELLM_MODES.has(String(m.mode))) continue;
    const input = perM(m.input_cost_per_token);
    const output = perM(m.output_cost_per_token);
    if (input === 0 && output === 0) continue;
    const cacheWrite = perM(m.cache_creation_input_token_cost) || input;
    const cacheRead = perM(m.cache_read_input_token_cost);
    const cacheWrite1h = perM(m.cache_creation_input_token_cost_above_1hr);
    const k = normalizeModelKey(key);
    const row: PriceRow =
      cacheWrite1h > 0
        ? [input, output, cacheWrite, cacheRead, cacheWrite1h]
        : [input, output, cacheWrite, cacheRead];
    const next = { rank: providerRank(m.litellm_provider), canonical: key === k };

    const cur = meta.get(k);
    if (!cur) {
      meta.set(k, next);
      out[k] = row;
      continue;
    }
    const wins =
      next.rank < cur.rank || (next.rank === cur.rank && next.canonical && !cur.canonical);
    const sameListPrice = out[k][0] === input && out[k][1] === output;
    if (wins) {
      // Keep the loser's richer cache pricing when the list price agrees.
      if (sameListPrice && cacheRead === 0 && out[k][3] > 0) {
        row[2] = out[k][2];
        row[3] = out[k][3];
      }
      if (sameListPrice && row[4] === undefined && out[k][4] !== undefined) {
        row[4] = out[k][4];
      }
      meta.set(k, next);
      out[k] = row;
    } else if (sameListPrice) {
      if (out[k][3] === 0 && cacheRead > 0) {
        out[k][2] = cacheWrite;
        out[k][3] = cacheRead;
      }
      if (out[k][4] === undefined && cacheWrite1h > 0) out[k][4] = cacheWrite1h;
    }
  }
  return out;
}

/**
 * Normalize a model id to the table's key space: lowercase, no gateway path
 * prefixes ("openrouter/anthropic/x" → "x"), no Bedrock region/vendor dot
 * prefixes ("us.anthropic.claude-x" → "claude-x"), no Bedrock version suffix
 * ("-v2:0"), no vertex "@20250219" date (retried dash-style by the resolver).
 */
export function normalizeModelKey(model: string): string {
  let k = model.toLowerCase().trim();
  while (k.includes("/")) k = k.slice(k.indexOf("/") + 1);
  k = k.replace(/^(?:[a-z0-9_-]+\.)+(?=[a-z])/, (prefix) =>
    // Only strip dot-prefixes that look like region/vendor qualifiers, not a
    // dotted model name like "gpt-5.1" (those never precede more letters+dots).
    /^(?:us|eu|au|jp|apac|global|anthropic|amazon|meta|openai|google|vertex|azure|mistral)\./.test(prefix) ? "" : prefix,
  );
  // Bedrock revision suffix (":0" in "...-v1:0"). Only the ":N" part — the
  // "-vN" may BE the model version (legacy "claude-v2:1" must not become
  // bare "claude"); the resolver's tail-trim handles a dangling "-v1".
  k = k.replace(/:\d+$/, "").replace(/:latest$/, "");
  // Client-side variant tags such as Claude Code's 1M-context "[1m]" are not
  // part of the billed model id ("claude-opus-4-6[1m]" bills as claude-opus-4-6).
  k = k.replace(/\[[^\]]*\]$/, "");
  return k;
}

function lookup(key: string): PriceRow | undefined {
  return liveTable?.[key] ?? MODEL_PRICES[key];
}

/**
 * Resolve a model id to per-1M rates: exact → date-suffix stripped →
 * progressive tail-segment trim → family tier. Null when nothing matches.
 * Memoized per raw model string (cleared when live pricing changes).
 */
export function resolveModelPrice(model: string): ModelPrice | null {
  return resolveCached(model, false);
}

/**
 * Like `resolveModelPrice`, but only from the price TABLE (exact id, date
 * suffix, or tail-trimmed variant) — never the family-tier guess. Use this
 * where a price is going to override a number someone else computed: a guess
 * must never raise a recorded cost.
 */
export function resolveModelPriceStrict(model: string): ModelPrice | null {
  return resolveCached(model, true);
}

function resolveCached(model: string, strict: boolean): ModelPrice | null {
  const cacheKey = strict ? `\u0000strict\u0000${model}` : model;
  const hit = resolveCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const resolved = resolveModelPriceUncached(model, strict);
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(cacheKey, resolved);
  return resolved;
}

function exactCandidates(model: string): { candidates: string[]; dateless: string } {
  const norm = normalizeModelKey(model);
  const candidates = [norm];
  // "claude-opus-4-8-20260901" / "gpt-5.2-2025-12-11" / "gemini-x@20250219"
  const dateless = norm
    .replace(/[-@]20\d{6}$/, "")
    .replace(/-20\d{2}-\d{2}-\d{2}$/, "");
  if (dateless !== norm) candidates.push(dateless);
  if (norm.endsWith("-latest")) candidates.push(norm.slice(0, -"-latest".length));
  return { candidates, dateless };
}

function lookupExact(model: string): PriceRow | undefined {
  for (const c of exactCandidates(model).candidates) {
    const row = lookup(c);
    if (row) return row;
  }
  return undefined;
}

function resolveModelPriceUncached(model: string, strict: boolean): ModelPrice | null {
  const { dateless } = exactCandidates(model);
  let row: PriceRow | undefined = lookupExact(model);
  if (!row) {
    // Trim trailing "-segment"s (thinking/effort/size variants a vendor tacks
    // on) until a known id emerges; stop before the name loses its identity —
    // never degrade to a single word ("claude-opus-99" must reach the opus
    // family tier below, not a generic bare-"claude" alias).
    let base = dateless;
    for (let i = 0; i < 3 && !row; i++) {
      const cut = base.lastIndexOf("-");
      if (cut < 1) break;
      const next = base.slice(0, cut);
      if (!next.includes("-")) break;
      base = next;
      row = lookup(base);
    }
  }
  if (!row && !strict) row = FALLBACK_TIERS.find((t) => t.match.test(model))?.row;
  if (!row) return null;
  const cacheWrite1h = Number(row[4]) > 0 ? Number(row[4]) : row[2];
  return { in: row[0], out: row[1], cacheWrite: row[2], cacheRead: row[3], cacheWrite1h };
}

function priceTokens(p: ModelPrice, t: PricingTokenCounts): number {
  const cacheWrite = Math.max(0, t.cacheCreationTokens);
  const write1h = Math.min(cacheWrite, Math.max(0, Number(t.cacheCreation1hTokens) || 0));
  const usd =
    (t.inputTokens * p.in +
      t.outputTokens * p.out +
      (cacheWrite - write1h) * p.cacheWrite +
      write1h * p.cacheWrite1h +
      t.cacheReadTokens * p.cacheRead) /
    1_000_000;
  return usd > 0 ? Math.round(usd * 1e6) / 1e6 : 0;
}

/** Estimate USD cost for a model + token counts. Unknown models → 0. */
export function estimateCostUSD(model: string, t: PricingTokenCounts): number {
  const p = resolveModelPrice(model);
  return p ? priceTokens(p, t) : 0;
}

/**
 * List-price cost from the price TABLE only (no family guess), or null when
 * the table doesn't know the model. See `resolveModelPriceStrict`.
 */
export function tableCostUSD(model: string, t: PricingTokenCounts): number | null {
  const p = resolveModelPriceStrict(model);
  return p ? priceTokens(p, t) : null;
}

/**
 * Tools whose cost is, by construction, token counts × a public price table
 * (Claude Code, Codex): nothing they run is cheaper than list price. For
 * these, a recorded cost BELOW the table's list price is a pricing failure —
 * an old CLI or ccusage bundle that predates the model ($0), or a day cost
 * split across models by token share — never a real discount. Tools that
 * record the vendor's actual charge (OpenCode, Cursor, Amp...) can be
 * legitimately free or discounted and are excluded.
 */
export const LIST_PRICE_TOOLS: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * Raise a list-price tool's recorded cost to at least the table's list price
 * for its tokens. A HIGHER recorded cost is kept: per-request premiums the
 * daily totals can't reproduce (long-context tiers, priority/fast mode) only
 * ever add. Unknown models, guessed (family-tier) prices and other tools pass
 * through unchanged. The result never exceeds the server's $/token ceiling.
 */
export function floorCostAtListPrice(
  tool: string,
  model: string,
  t: PricingTokenCounts,
  recordedCostUSD: number,
): number {
  const recorded = Number.isFinite(recordedCostUSD) && recordedCostUSD > 0 ? recordedCostUSD : 0;
  if (!LIST_PRICE_TOOLS.has(tool)) return recorded;
  const table = tableCostUSD(model, t);
  if (table === null || table <= recorded) return recorded;
  const tokens = t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
  // Stay a hair under the server's ceiling so rounding can never cross it.
  const ceiling = (tokens * MAX_USD_PER_MTOK * 0.99) / 1_000_000;
  return Math.max(recorded, Math.min(table, ceiling));
}

/**
 * USD saved by `cacheReadTokens` being billed at the cheap cache-read rate
 * instead of the full input rate for this model. The headline "money saved by
 * prompt caching" number. Unknown models → 0.
 */
export function cacheSavingsUSD(model: string, cacheReadTokens: number): number {
  const p = resolveModelPrice(model);
  if (!p || cacheReadTokens <= 0) return 0;
  const usd = (cacheReadTokens * (p.in - p.cacheRead)) / 1_000_000;
  return usd > 0 ? Math.round(usd * 1e6) / 1e6 : 0;
}

/**
 * Anti-cheat helper: the minimum plausible blended USD-per-1M-token rate for a
 * KNOWN model — its cheapest billing bucket (cache read) with a 4x safety
 * margin for pricing drift, vendor discounts, and old CLI tables. Null when
 * the model is unknown or its cache-read rate is unpriced (a legitimate entry
 * could then blend arbitrarily low, so no per-model floor can be asserted).
 */
export function minPlausibleUSDPerMTok(model: string): number | null {
  const p = resolveModelPrice(model);
  if (!p || p.cacheRead <= 0) return null;
  return p.cacheRead / 4;
}
