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
  needsSocial?: boolean | null;
}): string[] {
  if (result.orgBoardUrl) {
    return [
      `  🏢 You're on your team board: ${sanitizeServerText(result.orgBoardUrl)}`,
      "  → Open it to see who burned more.",
    ];
  }
  if (result.boardUrl) {
    const code = result.boardUrl.split("/").filter(Boolean).pop() ?? "";
    // Friends boards rank only publicly listed members, so a member without a
    // social handle has joined but is not shown yet — say exactly that.
    if (result.needsSocial) {
      return [
        `  🤝 You joined the board: ${sanitizeServerText(result.boardUrl)}`,
        "  → You'll show up on it once you're on the public leaderboard:",
        `  → add a social handle (X, GitHub, or Instagram) on your dashboard: ${sanitizeServerText(result.profileUrl)}`,
      ];
    }
    return [
      `  🤝 You're on the board: ${sanitizeServerText(result.boardUrl)}`,
      "  → Open it to see who burned more.",
      `  → Get a friend on it — have them run: npx whoburnedmore --board=${sanitizeServerText(code)}`,
    ];
  }
  // Signed in but not on the public board yet — the ONLY thing missing is a
  // social handle. Say so plainly instead of implying they already rank.
  if (result.needsSocial) {
    return [
      `  Your dashboard: ${sanitizeServerText(result.profileUrl)}`,
      "  → You're synced, but not on the public leaderboard yet.",
      "  → Add a social handle (X, GitHub, or Instagram) on your dashboard to appear.",
    ];
  }
  return [
    `  Your dashboard: ${sanitizeServerText(result.profileUrl)}`,
    "  → Open it to see your rank and share your profile.",
  ];
}

/**
 * The submit API joins a board/org only when the code (and org password) are
 * right, and otherwise just leaves the field out of its reply — so a typo'd
 * code, wrong --pass or missing --pass used to look exactly like success.
 * Compare what the user asked for with what the server confirmed.
 */
export function scopeWarningLines(
  requested: { board?: string; org?: string; orgCode?: string },
  result: { boardUrl?: string | null; orgBoardUrl?: string | null },
): string[] {
  const lines: string[] = [];
  if (requested.board && !result.boardUrl) {
    lines.push(
      `  ! Didn't join friends board "${sanitizeServerText(requested.board)}" — check the code (your usage still synced).`,
    );
  }
  if (requested.org && !result.orgBoardUrl) {
    lines.push(
      requested.orgCode
        ? `  ! Didn't join org "${sanitizeServerText(requested.org)}" — check the org name and the --pass code (your usage still synced).`
        : `  ! Didn't join org "${sanitizeServerText(requested.org)}" — it may need a password: add --pass=CODE from your org's page (your usage still synced).`,
    );
  }
  return lines;
}

/**
 * One line telling the user what the sync achieved: the account total the
 * server now holds, their all-time rank (only when they are publicly listed,
 * so it can't contradict a "not on the board yet" message), and how many days
 * this sync covered.
 */
export function syncSummaryLine(
  result: { totalTokens?: number | null; rank?: number | null; listed?: boolean | null },
  entries: ReadonlyArray<{ date: string }>,
): string | null {
  if (typeof result.totalTokens !== "number" || !Number.isFinite(result.totalTokens)) return null;
  const days = new Set(entries.map((e) => e.date)).size;
  const parts = [`${formatTokens(result.totalTokens)} tokens on your account`];
  if (result.listed && typeof result.rank === "number" && result.rank > 0) {
    parts.push(`#${result.rank} all-time`);
  }
  if (days > 0) parts.push(`this sync covered ${days} day${days === 1 ? "" : "s"}`);
  return `  ${parts.join(" · ")}`;
}
