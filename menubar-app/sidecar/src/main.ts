/**
 * burnbar-sidecar — BurnBar's headless engine (bun single-file executable).
 *
 * Commands:
 *   snapshot   one-shot: full collect (native + long tail), print Summary JSON
 *   limits     one-shot: print Limits JSON (codex rate limits from local logs,
 *              cursor plan usage best-effort over the network)
 *   sync       one-shot: collect + submit to whoburnedmore via the CLI's stored
 *              sign-in (~/.config/whoburnedmore/config.json). `--dry-run` prints
 *              row counts instead of submitting.
 *   watch      long-running: NDJSON event stream, FSEvents-driven (see watch.ts)
 *   version    print version
 *
 * Env: BURNBAR_CCUSAGE (path to standalone ccusage binary), BURNBAR_CACHE_DIR,
 *      BURNBAR_DEBOUNCE_MS, BURNBAR_SLOW_INTERVAL_MS, plus the standard reader
 *      envs (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME).
 */
import { readCodexLimits } from "./codex-limits.js";
import { claudeSessionNames, collectNativeTier, collectSlowTier, mergeTiers } from "./collector.js";
import { fetchCursorLimits } from "./cursor-limits.js";
import { summarize } from "./summarize.js";
import { runSync } from "./sync.js";
import { runWatch } from "./watch.js";

const VERSION = "0.7.2";

async function snapshot(): Promise<void> {
  const [native, slow] = await Promise.all([
    collectNativeTier(),
    collectSlowTier().catch(() => null),
  ]);
  const entries = mergeTiers(native, slow);
  const toolsFound = [...new Set([...native.toolsFound, ...(slow?.toolsFound ?? [])])];
  console.log(
    JSON.stringify(
      summarize(entries, toolsFound, native.partial, new Date(), slow?.sessions ?? [], claudeSessionNames()),
      null,
      2,
    ),
  );
}

async function limits(): Promise<void> {
  const cursor = await fetchCursorLimits();
  console.log(JSON.stringify({ codex: readCodexLimits(), cursor }, null, 2));
}

const cmd = process.argv[2] ?? "snapshot";
switch (cmd) {
  case "snapshot":
    await snapshot();
    break;
  case "limits":
    await limits();
    break;
  case "sync":
    await runSync({
      dryRun: process.argv.includes("--dry-run"),
      nativeOnly: process.argv.includes("--native-only"),
    });
    break;
  case "watch":
    await runWatch();
    break;
  case "version":
  case "--version":
    console.log(VERSION);
    break;
  default:
    console.error(`unknown command: ${cmd} (expected snapshot|limits|sync|watch|version)`);
    process.exit(2);
}
