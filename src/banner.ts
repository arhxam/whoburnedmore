import pc from "picocolors";
import { PUBLIC_PRODUCT_NAME } from "./brand.js";

/**
 * The startup banner: the "whoburnedmore?" wordmark painted in a flame gradient
 * (hot yellow → ember-orange, left to right), framed by a thin rule so it reads
 * as one tidy block instead of loose ASCII. Printed once at the top of a normal
 * run — never in quiet/background-sync mode.
 */
const WORD = PUBLIC_PRODUCT_NAME;
// 256-colour flame gradient, hot (left) → ember (right).
const SHADES = [226, 220, 214, 208, 202, 196];

function paintWordmark(): string {
  if (!pc.isColorSupported) return `${WORD}?`;
  const letters = [...WORD]
    .map((ch, i) => `\x1b[1;38;5;${SHADES[i % SHADES.length]}m${ch}`)
    .join("");
  return `${letters}\x1b[1;38;5;208m?\x1b[0m`;
}

export function printBanner(): void {
  const rule = pc.dim("─".repeat(30));
  console.log();
  console.log(`  🔥  ${paintWordmark()}`);
  console.log(`  ${rule}`);
  console.log(`  ${pc.dim("who burned more — you, or them?")}`);
  console.log();
}
