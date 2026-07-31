/**
 * Google Antigravity detection + honest "why it isn't counted" notice.
 *
 * Antigravity IS a major agent, but — unlike every other tool we read — it keeps
 * no readable local usage ledger. Its conversations under
 * `~/.gemini/antigravity/conversations/*.pb` are ENCRYPTED (opaque high-entropy
 * blobs), the only local usage key in its VS Code state DB is a sentinel stub,
 * and it bills flat-rate so Google records no per-request token/cost anywhere on
 * disk. Live usage is exposed only as remaining-quota counters via an
 * undocumented loopback/Cloud-Code API — an aggregate, not the per-day/per-model
 * token rows (with an anti-fraud request fingerprint) the leaderboard is built
 * on. Fabricating estimates from that would violate our usage-integrity model.
 *
 * So we do the honest thing: DETECT Antigravity and tell the user plainly that
 * it can't be counted, rather than silently implying "no usage from any agent".
 * If Antigravity ever ships a readable local usage log, this becomes a real
 * reader like the others.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Antigravity data directory for the current user (may not exist). */
export function antigravityDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".gemini", "antigravity");
}

/** True when Google Antigravity appears to be installed for this user. */
export function detectAntigravity(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(antigravityDataDir(env));
}

/** Plain-text lines explaining that detected Antigravity usage can't be counted. */
export function antigravityNoticeLines(): string[] {
  return [
    "  • Google Antigravity detected — but its usage can't be counted.",
    "    Antigravity stores no readable local usage: its conversation logs are",
    "    encrypted and it bills flat-rate, so there are no per-request token",
    "    counts on disk to tally. It's the one major agent we can't put on the board.",
  ];
}
