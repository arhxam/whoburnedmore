export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function formatUSD(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Strip terminal control bytes (C0, DEL, C1) from any string that came BACK from
 * the server before it is printed. A hostile, compromised, or MITM'd API response
 * (or a user-pointed WHOBURNEDMORE_API) could otherwise embed ANSI/OSC escape
 * sequences — OSC 52 clipboard writes, window-title rewrites, hyperlink spoofing,
 * cursor games — that take effect the moment the line is printed. The background
 * sync prints these unattended every 15 minutes, so escaping at the print
 * boundary matters. Printable text (URLs, handles, codes) is left intact; only the
 * escape bytes are removed.
 */
export function sanitizeServerText(s: string): string {
  // eslint-disable-next-line no-control-regex -- the whole point is to remove control bytes
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Two lines shown only before this machine has ever signed in. */
export const FIRST_RUN_PRIVACY_LINES = [
  "  Counting your token usage and posting your rank — only daily totals leave your machine, never your prompts or code.",
  "  (`--local` keeps it fully offline · `private`/`remove` pull it anytime · details: whoburnedmore.com/trust)",
];

/**
 * Startup copy. A returning signed-in session gets one line. The two privacy
 * lines are only for a machine that has not signed in yet.
 */
export function runIntroLines(opts: {
  handle?: string | null;
  signedIn?: boolean;
}): { lines: string[]; dim: boolean } {
  if (opts.signedIn && opts.handle) {
    return {
      lines: [`  Signed in as @${sanitizeServerText(opts.handle)}`],
      dim: false,
    };
  }
  if (opts.signedIn) return { lines: ["  Signed in."], dim: false };
  return { lines: [...FIRST_RUN_PRIVACY_LINES], dim: true };
}

/** `WHOBURNEDMORE_NO_OPEN=1` disables every browser open. */
export function envDisablesDashboardOpen(value: string | undefined): boolean {
  return value?.trim() === "1";
}

/**
 * Open the web dashboard only after a sign-in that happened in this run, or
 * when the user passed `--open`. Never without a TTY, and never when opening
 * is disabled.
 */
export function shouldOpenDashboard(opts: {
  stdoutIsTTY: boolean;
  noOpen: boolean;
  signedInThisRun: boolean;
  open: boolean;
}): boolean {
  if (!opts.stdoutIsTTY || opts.noOpen) return false;
  return opts.signedInThisRun || opts.open;
}

/** Empty answer follows the default. `y` / `yes` is the only acceptance. */
export function acceptedConfirm(answer: string, defaultYes: boolean): boolean {
  const trimmed = answer.trim();
  if (!trimmed) return defaultYes;
  return /^y(es)?$/i.test(trimmed);
}

/**
 * Identity of one suppression event. A later event (different held days, or a
 * new suppression after the account was cleared) asks "Verify now?" again.
 * Null when the account is not suppressed.
 */
export function suppressionSignature(result: {
  suppressed?: boolean | null;
  quarantinedDates?: readonly string[] | null;
}): string | null {
  if (!result.suppressed) return null;
  const days = [...(result.quarantinedDates ?? [])].sort().join(",");
  return `suppressed:${days}`;
}

/** `whoami` / startup status. */
export function whoamiLine(handle: string | null | undefined, signedIn: boolean): string {
  if (signedIn && handle) return `  Signed in as @${sanitizeServerText(handle)}`;
  if (signedIn) return "  Signed in.";
  return "  Not signed in. Run `npx whoburnedmore login`.";
}

/** One bullet for `status`. Always includes the words "Signed in as". */
export function statusSignedInLine(handle: string | null): string {
  if (handle === null) return "  • Signed in as: not signed in";
  if (!handle) return "  • Signed in";
  return `  • Signed in as @${sanitizeServerText(handle)}`;
}

/**
 * Post-submit summary for a signed-in run, as one line:
 * `@handle · rank #N · <url>`. Rank is omitted when the server didn't send one.
 * The URL prefers the org board, then a friends board, then the profile.
 * Free of usage numbers. Pure and side-effect-free for tests.
 */
export function signedInNextStepLines(result: {
  handle?: string | null;
  rank?: number | null;
  profileUrl: string;
  boardUrl?: string | null;
  orgBoardUrl?: string | null;
}): string[] {
  const url = result.orgBoardUrl || result.boardUrl || result.profileUrl;
  const parts: string[] = [];
  if (result.handle) parts.push(`@${sanitizeServerText(result.handle)}`);
  if (typeof result.rank === "number") parts.push(`rank #${result.rank}`);
  parts.push(sanitizeServerText(url));
  return [`  ${parts.join(" · ")}`];
}
