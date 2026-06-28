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

/**
 * The post-submit "next steps" lines printed by the CORE (online) command. This
 * is intentionally free of any usage numbers — the web dashboard is where a user
 * reviews their burn. It returns the destination URL plus the single next step
 * that gets them onto the leaderboard (sign in + add X). Pure + side-effect-free
 * so it can be asserted in tests.
 */
export function submitNextStepLines(result: {
  dashboardUrl: string;
  boardUrl?: string | null;
  boardCode?: string | null;
}): string[] {
  if (result.boardUrl) {
    // Derive the join command's code from the explicit field, falling back to the
    // last URL segment, so we can hand the user the exact thing to send a friend.
    const code =
      result.boardCode ?? result.boardUrl.split("/").filter(Boolean).pop() ?? "";
    return [
      `  🤝 You're on the board: ${sanitizeServerText(result.boardUrl)}`,
      "  → Open it to see who burned more.",
      `  → Get a friend on it — have them run: npx whoburnedmore --board=${sanitizeServerText(code)}`,
      "  → Sign in on the page and add your X to claim your spot and own your rank.",
    ];
  }
  return [
    `  Your dashboard: ${sanitizeServerText(result.dashboardUrl)}`,
    "  → Sign in and add your X on the page to get on the leaderboard and claim your rank.",
    "  Private until you do. Manage anytime: `npx whoburnedmore private` · `public` · `remove`.",
  ];
}
