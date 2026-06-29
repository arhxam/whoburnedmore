import type { AnonSubmitResponse, SubmitPayload } from "./shared.js";

export interface ServerInstallRedeemResponse {
  ok: true;
  handle: string;
  profileUrl: string;
  mergedDays: number;
  alreadyLinked: boolean;
}

export function apiBase(): string {
  const url = process.env.WHOBURNEDMORE_API;
  if (!url) {
    throw new Error("WHOBURNEDMORE_API is not set in the environment.");
  }
  return url;
}

/**
 * The web app origin. The local dashboard bakes this into
 * its "Connect your account" form so the file:// page can hand its data off to
 * the website. Overridable for local dev / tests.
 */
export function webBase(): string {
  const url = process.env.WHOBURNEDMORE_WEB;
  if (!url) {
    throw new Error("WHOBURNEDMORE_WEB is not set in the environment.");
  }
  return url;
}

/**
 * True only if `url` is an http(s) URL whose origin matches the configured web base
 * (`WHOBURNEDMORE_WEB`). The CLI opens a
 * dashboard/board URL that comes BACK from the server, so a malicious or MITM'd server
 * could otherwise return a `javascript:` / `file:` / custom-scheme / wrong-host URL and
 * make the OS launch an arbitrary handler. Guard the host before ever auto-opening.
 */
export function isTrustedWebUrl(url: string): boolean {
  let u: URL;
  let base: URL;
  try {
    u = new URL(url);
    base = new URL(webBase());
  } catch {
    return false; // not a parseable absolute URL (e.g. "-a foo", "javascript:…")
  }
  return (
    (u.protocol === "https:" || u.protocol === "http:") &&
    u.protocol === base.protocol &&
    u.host === base.host
  );
}

/**
 * True only if `url` is safe to hand to the OS opener (`open`/`xdg-open`/`start`): an
 * http(s) URL or a local `file:` URL. Blocks `javascript:`/`data:`/custom schemes and any
 * leading-`-` string that the opener would treat as a command-line flag. Second layer under
 * `isTrustedWebUrl` — used for the locally-built `file://` dashboard too.
 */
export function isOpenableUrl(url: string): boolean {
  return /^(https?|file):\/\//.test(url);
}

/** Parse a response body as JSON, tolerating empty or non-JSON responses. */
async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // The gateway returned HTML/plain text (e.g. a 502/503 during an Azure cold
    // start or deploy). Surface a clear, parseable error instead of a raw
    // "Unexpected token <" crash.
    return {
      error:
        res.status >= 500
          ? "the leaderboard server is temporarily unavailable — try again in a minute"
          : `unexpected response from the server (HTTP ${res.status})`,
    } as T;
  }
}

async function post<T>(
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Bound the request so a slow/black-holing/hostile server can't hang the CLI
      // — or the unattended 15-minute background sync — indefinitely.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      "couldn't reach the leaderboard server — check your connection and try again",
    );
  }
  return { status: res.status, body: await readJson<T>(res) };
}

/** Submit anonymously: no sign-in, the key owns a public, shareable dashboard. */
export async function anonSubmit(
  anonKey: string,
  payload: SubmitPayload,
): Promise<AnonSubmitResponse> {
  const { status, body } = await post<
    AnonSubmitResponse | { error: string; details?: string[] }
  >("/v1/anon/submit", { ...payload, anonKey });
  if (status !== 200) {
    const err = body as { error: string; details?: string[] };
    const details = err.details?.length ? `\n  - ${err.details.join("\n  - ")}` : "";
    throw new Error(`${err.error ?? `submit failed (HTTP ${status})`}${details}`);
  }
  return body as AnonSubmitResponse;
}

/**
 * Append this machine's owner key to its dashboard URL as a fragment. The CLI
 * opens this so the browser can offer "claim" — the fragment is never sent to
 * the server or leaked in referrers/logs.
 */
export function claimUrl(dashboardUrl: string, anonKey: string): string {
  return `${dashboardUrl}#k=${encodeURIComponent(anonKey)}`;
}

/**
 * Open a freshly-joined friends board with the same claim handoff a solo run
 * gets on /d/<slug>: the owner key plus this device's dashboard slug, both as
 * URL fragment params (never sent to the server / leaked in referrers). The
 * board page reads them so signing in there CLAIMS this machine's submission —
 * merging the usage and carrying the board membership onto the account — so the
 * joiner shows up as a real, named row instead of "anonymous". The `u=<slug>`
 * also lets the board highlight "that's you" and surface the claim prompt.
 */
export function boardClaimUrl(
  boardUrl: string,
  slug: string,
  anonKey: string,
): string {
  return `${boardUrl}#k=${encodeURIComponent(anonKey)}&u=${encodeURIComponent(slug)}`;
}

/**
 * Decide where a finished run should send the user, and the exact URL to open.
 * Priority: the ORG board they just joined (the brief — a run with `--org` always
 * lands on the org leaderboard), then a friends board, then their own dashboard.
 * The org/board URLs carry the claim handoff (#k=&u=) so a not-yet-indexed runner
 * signs in + adds a social on arrival; the dashboard gets the plain claim handoff.
 * Pure + unit-testable; `index.ts` opens `target` and prints `baseUrl` on distrust.
 */
export function resolveOpenTarget(
  result: {
    orgBoardUrl?: string;
    boardUrl?: string;
    dashboardUrl: string;
    slug: string;
  },
  anonKey: string,
): { baseUrl: string; target: string } {
  const baseUrl = result.orgBoardUrl ?? result.boardUrl ?? result.dashboardUrl;
  const target = result.orgBoardUrl
    ? boardClaimUrl(result.orgBoardUrl, result.slug, anonKey)
    : result.boardUrl
      ? boardClaimUrl(result.boardUrl, result.slug, anonKey)
      : claimUrl(result.dashboardUrl, anonKey);
  return { baseUrl, target };
}

/** Show or hide this machine's anonymous dashboard on the public leaderboard. */
export async function anonVisibility(
  anonKey: string,
  listed: boolean,
): Promise<void> {
  const { status, body } = await post<{ error?: string }>(
    "/v1/anon/visibility",
    { anonKey, listed },
  );
  if (status !== 200) {
    throw new Error(body.error ?? `failed (HTTP ${status})`);
  }
}

/** Permanently delete this machine's anonymous dashboard and its usage. */
export async function anonRemove(anonKey: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/anon`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anonKey }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `failed (HTTP ${res.status})`);
  }
}

/** Redeem a one-time install token generated from the signed-in profile page. */
export async function redeemServerInstall(
  token: string,
  anonKey: string,
): Promise<ServerInstallRedeemResponse> {
  const { status, body } = await post<
    ServerInstallRedeemResponse | { error?: string }
  >("/v1/server-install/redeem", { token, anonKey });
  if (status !== 200) {
    throw new Error(
      (body as { error?: string }).error ?? `server install failed (HTTP ${status})`,
    );
  }
  return body as ServerInstallRedeemResponse;
}
