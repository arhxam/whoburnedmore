/**
 * Google Antigravity detection + an honest notice for when it yields nothing.
 *
 * Current Antigravity builds (desktop, CLI, IDE) keep a per-conversation SQLite
 * ledger at `~/.gemini/<antigravity|antigravity-cli|antigravity-ide>/
 * conversations/*.db`, which the bundled ccusage (>= 20.0.29) reads as the
 * `antigravity` source. Older builds kept only encrypted `*.pb` conversation
 * blobs with no per-request token counts; those can't be counted, and we
 * never estimate usage we can't read. This notice is shown when Antigravity is
 * installed so a user whose board shows nothing from it knows why.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Antigravity data roots for the current user (any may be missing). */
export function antigravityDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const gemini = join(env.HOME || homedir(), ".gemini");
  return ["antigravity", "antigravity-cli", "antigravity-ide"].map((name) =>
    join(gemini, name),
  );
}

/** True when Google Antigravity (desktop, CLI or IDE) appears to be installed. */
export function detectAntigravity(env: NodeJS.ProcessEnv = process.env): boolean {
  return antigravityDataDirs(env).some((dir) => existsSync(dir));
}

/** Plain-text lines explaining how Antigravity usage is (and isn't) counted. */
export function antigravityNoticeLines(): string[] {
  return [
    "  • Google Antigravity detected. Its usage is read from the local",
    "    conversation databases (~/.gemini/antigravity*/conversations/*.db).",
    "    Older Antigravity versions kept only encrypted logs with no token",
    "    counts; that history can't be counted. Update Antigravity if none shows.",
  ];
}
