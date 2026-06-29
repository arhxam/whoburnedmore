/**
 * Pure host -> tenant resolution, shared by the Next.js middleware and tests.
 *
 * The web app is multi-tenant: the apex (whoburnedmore.com / www) is the global
 * product, `<slug>.whoburnedmore.com` is an organization's subdomain, and any
 * other host is treated as a candidate custom domain (resolved to an org by a
 * lookup the caller performs). Keeping this logic pure and dependency-free makes
 * it unit-testable without booting Next.
 */

export type Tenant =
  | { kind: "apex" }
  | { kind: "subdomain"; slug: string }
  | { kind: "custom"; host: string };

/** The production root domain. Overridable for tests / preview environments / env variables. */
export const ROOT_DOMAIN = process.env.WHOBURNEDMORE_ROOT_DOMAIN || "whoburnedmore.com";

/**
 * Subdomains that must always resolve to the apex app, never to an org — these
 * are infra/product hostnames, not tenant slugs.
 */
export const RESERVED_SUBDOMAINS = new Set<string>([
  "www",
  "api",
  "app",
  "admin",
  "mail",
  "email",
  "cdn",
  "static",
  "assets",
  "blog",
  "docs",
  "status",
  "help",
  "support",
  "ingest",
  "vercel",
  "preview",
  "staging",
  "dev",
  "test",
]);

function isIpLiteral(host: string): boolean {
  // IPv4 or anything wrapped in brackets (IPv6) — never a tenant.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/** Lowercase, strip port, strip a trailing dot. */
export function normalizeHost(host: string): string {
  return (host || "")
    .trim()
    .toLowerCase()
    .split(":")[0]
    .replace(/\.$/, "")
    .trim();
}

/**
 * Resolve an incoming Host header to a tenant.
 *
 * - apex / `www` -> `{ kind: "apex" }`
 * - `<slug>.<root>` (non-reserved, single label) -> `{ kind: "subdomain", slug }`
 * - `<slug>.localhost` (dev convenience) -> `{ kind: "subdomain", slug }`
 * - bare `localhost` / IP literal -> apex
 * - everything else -> `{ kind: "custom", host }` (the caller maps host -> org)
 */
export function resolveTenant(host: string, rootDomain: string = ROOT_DOMAIN): Tenant {
  const h = normalizeHost(host);
  const root = normalizeHost(rootDomain);
  if (!h) return { kind: "apex" };
  if (h === root || h === `www.${root}`) return { kind: "apex" };

  if (h.endsWith(`.${root}`)) {
    const sub = h.slice(0, h.length - root.length - 1);
    // Only a single, non-reserved label is a tenant slug. Deep subdomains
    // (`a.b.<root>`) and reserved labels fall back to the apex app.
    if (!sub || sub.includes(".") || RESERVED_SUBDOMAINS.has(sub)) {
      return { kind: "apex" };
    }
    return { kind: "subdomain", slug: sub };
  }

  if (h.endsWith(".localhost")) {
    const sub = h.slice(0, h.length - ".localhost".length);
    if (sub && !sub.includes(".") && !RESERVED_SUBDOMAINS.has(sub)) {
      return { kind: "subdomain", slug: sub };
    }
    return { kind: "apex" };
  }

  if (h === "localhost" || isIpLiteral(h)) return { kind: "apex" };

  return { kind: "custom", host: h };
}
