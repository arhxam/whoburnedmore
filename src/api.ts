import type {
  DeviceCodeResponse,
  DeviceTokenResponse,
  SubmitPayload,
  SubmitResponse,
  VerifyPayload,
  VerifyResponse,
} from "./shared.js";

export interface ServerInstallRedeemResponse {
  ok: true;
  handle: string;
  profileUrl: string;
  mergedDays: number;
  alreadyLinked: boolean;
  /** Authenticated CLI token so a headless install submits via /v1/submit. */
  cliToken?: string;
}

export function apiBase(): string {
  return process.env.WHOBURNEDMORE_API ?? "https://api.whoburnedmore.com";
}

/**
 * The web app origin (whoburnedmore.com). The local dashboard bakes this into
 * its "Connect your account" form so the file:// page can hand its data off to
 * the website. Overridable for local dev / tests.
 */
export function webBase(): string {
  return process.env.WHOBURNEDMORE_WEB ?? "https://whoburnedmore.com";
}

/**
 * True only if `url` is an http(s) URL whose origin matches the configured web base
 * (https://whoburnedmore.com by default, or WHOBURNEDMORE_WEB for dev). The CLI opens a
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

async function send<T>(
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // A signed-in run presents its CLI bearer token so the server attributes the
  // usage to the account (the authenticated /v1/submit path) instead of trusting
  // a body-supplied key.
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

async function post<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  return send<T>("POST", path, body, token);
}

/**
 * Upload the per-request forensic skeleton for a delisted account
 * (`whoburnedmore verify`). Authenticated with the CLI bearer token — the server
 * ties it to the signed-in account, analyzes it, and either relists the user
 * (pass), keeps them delisted (fail), or routes it to a human (review).
 */
export async function verifyUsage(
  token: string,
  payload: VerifyPayload,
): Promise<VerifyResponse> {
  const { status, body } = await post<
    VerifyResponse | { error: string; details?: string[] }
  >("/v1/verify", payload, token);
  if (status === 401) throw new UnauthorizedError();
  if (status !== 200) {
    const err = body as { error: string; details?: string[] };
    const details = err.details?.length
      ? `\n  - ${err.details.join("\n  - ")}`
      : "";
    throw new Error(`${err.error ?? "verification failed"}${details}`);
  }
  return body as VerifyResponse;
}

/** Thrown by `submit` when the server rejects the CLI token (expired/invalid). */
export class UnauthorizedError extends Error {
  constructor(message = "your sign-in has expired") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Begin the device sign-in flow: ask the server for a one-time user code and the
 * web URL where the signed-in user approves it. The CLI prints the code, opens
 * the URL, then polls `devicePoll` until approval.
 */
export async function deviceStart(): Promise<DeviceCodeResponse> {
  const { status, body } = await post<DeviceCodeResponse | { error?: string }>(
    "/v1/auth/device",
    {},
  );
  if (status !== 200) {
    throw new Error(
      (body as { error?: string }).error ?? `sign-in failed (HTTP ${status})`,
    );
  }
  return body as DeviceCodeResponse;
}

/** Poll the device-token endpoint once; returns pending/expired/ok(+token). */
export async function devicePoll(
  deviceCode: string,
): Promise<DeviceTokenResponse> {
  const { status, body } = await post<DeviceTokenResponse | { error?: string }>(
    "/v1/auth/device/token",
    { deviceCode },
  );
  if (status !== 200) {
    throw new Error(`sign-in failed (HTTP ${status})`);
  }
  return body as DeviceTokenResponse;
}

/**
 * Silently mint a fresh CLI bearer token from this machine's device key. The
 * server only honours a key whose hash is BOUND to an account (the claim /
 * server-install binding), so this recovers an unattended machine whose stored
 * token died — e.g. after a server-side JWT secret rotation — without a browser
 * or a human. Returns null when the machine can't self-heal (key unknown/unbound,
 * account blocked, network trouble); callers fall back to interactive sign-in.
 */
export async function refreshCliToken(
  anonKey: string,
): Promise<{ token: string; handle: string } | null> {
  try {
    const { status, body } = await post<{
      ok?: boolean;
      token?: string;
      handle?: string;
    }>("/v1/auth/cli/refresh", { anonKey });
    if (status === 200 && typeof body.token === "string" && body.token) {
      return { token: body.token, handle: body.handle ?? "" };
    }
  } catch {
    // Network trouble — self-heal is best-effort; the caller decides what's next.
  }
  return null;
}

/**
 * Bind this machine's device key to the signed-in account (idempotent). This is
 * what makes the machine recoverable via `refreshCliToken` after its bearer
 * token dies — a device-sign-in-only machine otherwise holds nothing the server
 * can verify. Returns true when the server gave a definitive answer (bound,
 * already bound, or refused), false on network trouble (worth retrying later).
 */
export async function bindDeviceKey(
  token: string,
  anonKey: string,
): Promise<boolean> {
  try {
    const { status } = await post<{ ok?: boolean }>(
      "/v1/me/devices/bind",
      { anonKey },
      token,
    );
    // 200 bound/already-linked; 409 owned by another account — both definitive.
    return status === 200 || status === 409;
  } catch {
    return false;
  }
}

/**
 * Submit usage as a SIGNED-IN user: the token authenticates the account, so no
 * key rides in the body and a fabricated POST can't target someone else. Throws
 * `UnauthorizedError` on a 401 so the caller can clear the token and re-sign-in.
 */
export async function submit(
  token: string,
  payload: SubmitPayload,
): Promise<SubmitResponse> {
  const { status, body } = await post<
    | SubmitResponse
    | { error: string; details?: string[]; reason?: string | null; appealUrl?: string }
  >("/v1/submit", payload, token);
  if (status === 401) throw new UnauthorizedError();
  if (status !== 200) {
    const err = body as {
      error: string;
      details?: string[];
      reason?: string | null;
      appealUrl?: string;
    };
    // A hard block (403) is a dead-end unless we tell the user WHY and WHERE to
    // contest it. Relay the operator's reason and the appeal link the server
    // returned, instead of a bare "account blocked".
    if (status === 403 && err.error === "account blocked") {
      const reason = err.reason ? `\n  Reason: ${err.reason}` : "";
      const appeal = err.appealUrl
        ? `\n  If you think this is a mistake, appeal at: ${err.appealUrl}`
        : "";
      throw new Error(`Your account is blocked.${reason}${appeal}`);
    }
    const details = err.details?.length ? `\n  - ${err.details.join("\n  - ")}` : "";
    throw new Error(`${err.error ?? `submit failed (HTTP ${status})`}${details}`);
  }
  return body as SubmitResponse;
}

/**
 * Show or hide the signed-in account on the public leaderboard
 * (`npx whoburnedmore private` / `public`). Same semantics as the web toggle:
 * opting out is sticky, and opting back IN only lists an eligible account —
 * `eligible:false` means a social handle is still missing, and the CLI explains
 * that instead of claiming success.
 */
export async function setVisibility(
  token: string,
  listed: boolean,
): Promise<{ listed: boolean; eligible: boolean }> {
  const { status, body } = await post<{
    ok?: boolean;
    listed?: boolean;
    eligible?: boolean;
    error?: string;
  }>("/v1/cli/visibility", { listed }, token);
  if (status === 401) throw new UnauthorizedError();
  if (status !== 200) {
    throw new Error(body.error ?? `failed (HTTP ${status})`);
  }
  return { listed: body.listed === true, eligible: body.eligible === true };
}

/**
 * Permanently delete the signed-in account's usage data from the leaderboard
 * (`npx whoburnedmore remove`). The account itself survives — deleting it stays
 * on the web dashboard behind a web session, so a machine token can never
 * destroy the account.
 */
export async function removeUsage(token: string): Promise<{ deletedDays: number }> {
  const { status, body } = await send<{
    ok?: boolean;
    deletedDays?: number;
    error?: string;
  }>("DELETE", "/v1/cli/usage", undefined, token);
  if (status === 401) throw new UnauthorizedError();
  if (status !== 200) {
    throw new Error(body.error ?? `failed (HTTP ${status})`);
  }
  return { deletedDays: body.deletedDays ?? 0 };
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
