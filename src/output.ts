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
 * Post-submit "next steps" for a SIGNED-IN run. The user is already on the
 * leaderboard (no "sign in + add X" funnel), so this just points them at the
 * destination — org board, friends board, or their own profile. Free of usage
 * numbers (the web reviews the burn). Pure + side-effect-free for tests.
 */
export function signedInNextStepLines(result: {
  profileUrl: string;
  boardUrl?: string | null;
  orgBoardUrl?: string | null;
}): string[] {
  if (result.orgBoardUrl) {
    return [
      `  🏢 You're on your team board: ${sanitizeServerText(result.orgBoardUrl)}`,
      "  → Open it to see who burned more.",
    ];
  }
  if (result.boardUrl) {
    const code = result.boardUrl.split("/").filter(Boolean).pop() ?? "";
    return [
      `  🤝 You're on the board: ${sanitizeServerText(result.boardUrl)}`,
      "  → Open it to see who burned more.",
      `  → Get a friend on it — have them run: npx whoburnedmore --board=${sanitizeServerText(code)}`,
    ];
  }
  return [
    `  Your dashboard: ${sanitizeServerText(result.profileUrl)}`,
    "  → Open it to see your rank and share your profile.",
  ];
}
