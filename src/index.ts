#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { SubmitPayload } from "./shared.js";
import {
  applyScope,
  parseBoard,
  parseInstallToken,
  parseOrg,
  parsePass,
  resolveCommand,
} from "./args.js";
import {
  anonSubmit,
  anonRemove,
  anonVisibility,
  resolveOpenTarget,
  apiBase,
  webBase,
  isTrustedWebUrl,
  isOpenableUrl,
  redeemServerInstall,
} from "./api.js";
import {
  autoSyncInstalled,
  installAutoSync,
  notifyLaunchLive,
  reconcileAutoSync,
  rotateLogIfLarge,
  syncIntervalLabel,
  SYNC_INTERVAL_MINUTES,
  uninstallAutoSync,
} from "./autosync.js";
import { printBanner } from "./banner.js";
import { daemonLoop } from "./daemon.js";
import { collectAll, type ProgressFn } from "./collect.js";
import {
  defaultConfigDir,
  ensureAnonKey,
  loadConfig,
  recordLaunchNotificationDelivered,
  recordSync,
  loadEnv,
} from "./config.js";
import { agentStatusReport } from "./status.js";
import { renderDashboardHtml } from "./local-dashboard.js";
import { sanitizeServerText, submitNextStepLines } from "./output.js";
import { publishLocal } from "./publish.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

/**
 * Reassuring, slightly playful narration shown beside the loading bar so the
 * wait feels like something is happening *for* you. Every line frames this as
 * *counting* — tokens, cache, cost — and is deliberately kept clear of any
 * "snooping" language: we never claim to read your conversations, and one line
 * states the privacy promise plainly (tokens & totals only, never prompts or
 * code). The bar cycles through these; the last one lands as we wrap up.
 */
const LOADING_VIBES = [
  "counting up your token usage, right here on your machine…",
  "tallying tokens across every coding agent you use…",
  "adding up cache reads, writes & all the burn…",
  "tokens & totals only — never your prompts or code…",
  "summing up your usage, model by model…",
  "working out what all that burn cost you 🔥",
  "crunching your daily token totals…",
  "almost there — adding it all up…",
];

/**
 * A determinate loading bar shown while we read local usage. It paints instantly
 * at 0% and eases smoothly toward each stage's target as `onProgress` fires, so
 * it never looks frozen. Alongside it we narrate what's happening (see
 * LOADING_VIBES), rotating the line every ~1.1s to keep the wait lively. On a
 * non-TTY it logs a few coarse percentage milestones instead. Never prompts.
 */
function startProgress(): { onProgress: ProgressFn; stop: () => void } {
  if (!process.stdout.isTTY) {
    // No cursor control off a TTY (piped, CI, some npx wrappers), so an animated
    // bar would smear into many lines. Print exactly ONE quiet line the first
    // time progress ticks and nothing more — a single loading indicator, no
    // percentage spam cluttering the terminal.
    let announced = false;
    return {
      onProgress: () => {
        if (announced) return;
        announced = true;
        console.log(pc.dim("  Counting your token usage…"));
      },
      stop: () => {},
    };
  }
  const width = 24;
  let target = 0; // 0..1 fraction we're easing toward
  let shown = 0; // 0..1 currently rendered fraction
  let ticks = 0; // render ticks, for rotating the narration line
  process.stdout.write("\x1b[?25l"); // hide cursor
  const vibe = () => {
    // Rotate every ~1.1s (≈18 ticks @ 60ms); pin to the final "almost there"
    // line once the bar is nearly full so the close-out reads naturally.
    if (shown >= 0.9) return LOADING_VIBES[LOADING_VIBES.length - 1];
    const i = Math.floor(ticks / 18) % (LOADING_VIBES.length - 1);
    return LOADING_VIBES[i];
  };
  const render = () => {
    ticks++;
    shown += (target - shown) * 0.3;
    if (target - shown < 0.004) shown = target;
    const filled = Math.round(shown * width);
    const bar = pc.yellow("█".repeat(filled)) + pc.dim("░".repeat(width - filled));
    const pct = String(Math.round(shown * 100)).padStart(3);
    process.stdout.write(`\r  ${bar} ${pct}%  ${pc.dim(vibe())}\x1b[K`);
  };
  render();
  const timer = setInterval(render, 60);
  return {
    // Stage labels are no longer surfaced (the narration is friendlier); we only
    // consume the done/total fraction to drive the bar.
    onProgress: (done, total) => {
      target = total > 0 ? done / total : 0;
    },
    stop: () => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K\x1b[?25h"); // clear the line + restore cursor
    },
  };
}

function openBrowser(url: string): void {
  // Never hand the OS opener anything but an http(s)/file URL — blocks javascript:/data:/
  // custom-scheme URLs and leading-dash arg-injection a hostile server response could carry.
  if (!isOpenableUrl(url)) return;
  const os = platform();
  const [cmd, args] =
    os === "darwin"
      ? ["open", [url]]
      : os === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${pc.dim("[Y/n]")} `)).trim();
  rl.close();
  return answer === "" || /^y(es)?$/i.test(answer);
}

interface Flags {
  dryRun: boolean;
  noSubmit: boolean;
  local: boolean;
  quiet: boolean;
  /** Friends-board code from `--board=<code>`: join it on submit and compare. */
  board?: string;
  /** Organization slug from `--org=<slug>`: join it on submit. */
  org?: string;
  /** Org join password from `--pass=<code>` / `--code=<code>`: gates the org join. */
  orgCode?: string;
}

/** Render the standalone local dashboard to the config dir and open it. */
function showLocalDashboard(payload: SubmitPayload): void {
  const dir = defaultConfigDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "dashboard.html");
  writeFileSync(
    file,
    renderDashboardHtml(payload.entries, new Date(), {
      payload,
      webBaseUrl: webBase(),
    }),
  );
  console.log();
  console.log(`  Local dashboard: ${pc.cyan(`file://${file}`)}`);
  console.log(pc.dim("  Re-run `npx whoburnedmore --local` to refresh it. Nothing left your machine."));
  openBrowser(`file://${file}`);
}

async function run(flags: Flags): Promise<void> {
  if (!flags.quiet) {
    printBanner();
    console.log(pc.dim(`  whoburnedmore v${VERSION} · ${flags.local ? "local mode" : apiBase()}`));
    // No prompt — just a one-line heads-up of exactly what's about to happen and
    // how to undo it. The dashboard is claimable/private/removable after the
    // fact, so we don't block the happy path on a confirmation.
    if (!flags.dryRun && !flags.noSubmit && !flags.local) {
      console.log(
        pc.dim("  Counting your token usage and posting your rank — only daily totals leave your machine, never your prompts or code."),
      );
      console.log(
        pc.dim("  (`--local` keeps it fully offline · `private`/`remove` pull it anytime · details: whoburnedmore.com/trust)"),
      );
    }
    console.log();
  }

  const progress = flags.quiet
    ? { onProgress: undefined as ProgressFn | undefined, stop: () => {} }
    : startProgress();
  let collected;
  try {
    collected = await collectAll(progress.onProgress);
  } finally {
    progress.stop();
  }
  const { entries, sessions, blocks, tools, skills, agent, attributionComplete } =
    collected;
  if (entries.length === 0) {
    console.log();
    console.log("  Nothing to burn yet — no local usage found from any coding agent.");
    console.log(pc.dim("  Use Claude Code, Codex, Gemini CLI (or friends) and come back."));
    return;
  }

  const payload: SubmitPayload = { cliVersion: VERSION, entries };
  // ccusage dates usage in the machine's LOCAL timezone, so report that zone's
  // UTC offset (minutes east of UTC; getTimezoneOffset is the inverse sign) and
  // let the server compute this member's daily/weekly board in their local day.
  payload.tzOffsetMinutes = -new Date().getTimezoneOffset();
  if (sessions.length > 0) payload.sessions = sessions;
  if (blocks.length > 0) payload.blocks = blocks;
  if (tools.length > 0) payload.tools = tools;
  if (skills.length > 0) payload.skills = skills;
  if (agent.messageCount > 0) payload.agent = agent;
  // Tell the server the breakdown is a full snapshot (only when we actually have
  // one) so it refreshes the dashboard unconditionally instead of no-shrinking.
  if (attributionComplete && (tools.length > 0 || skills.length > 0))
    payload.attributionComplete = true;
  applyScope(payload, flags);

  if (flags.dryRun) {
    console.log(pc.dim("\n  --dry-run: this exact payload would be sent, nothing else:\n"));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (flags.local) {
    // No usage numbers in the terminal here either — `--local` is fully offline,
    // so it writes its OWN dashboard (an HTML file it opens in the browser) and
    // points you there. Like the online command, the burn is reviewed in the
    // dashboard, never dumped into the terminal.
    showLocalDashboard(payload);
    // --local stays offline by default, but offer to publish from here.
    if (!flags.quiet && process.stdin.isTTY) {
      await publishLocal(payload, {
        confirm,
        ensureAnonKey,
        anonSubmit,
        openBrowser,
        log: (line) => console.log(pc.dim(line)),
      });
    }
    return;
  }

  if (flags.noSubmit) {
    console.log(pc.dim("  --no-submit: skipped the dashboard."));
    return;
  }

  // Always submit anonymously: the CLI never signs in (the web is the source of
  // truth for accounts). This machine's key owns a public, shareable dashboard;
  // sign in on the web to claim it — that binds this key to your account so
  // future runs keep landing there.
  const anonKey = ensureAnonKey();
  const result = await anonSubmit(anonKey, payload);
  // Record a successful sync so `status` can report freshness (truer than log mtime).
  try {
    recordSync();
  } catch {
    /* best-effort — never fail a submit over a freshness stamp */
  }
  try {
    const config = loadConfig();
    if (result.launch?.live && !config?.launchNotificationDeliveredAt) {
      if (notifyLaunchLive()) {
        recordLaunchNotificationDelivered();
      }
    }
  } catch {
    /* best-effort — never fail a submit over a launch notification */
  }
  // Take the user straight to their live page in the browser, first thing —
  // the board if they joined one, otherwise their claimable dashboard. Either
  // way we carry the claim handoff (key + slug) in the URL fragment so signing
  // in on that page claims this machine's submission instead of stranding it as
  // an anonymous row.
  // Land the runner on the ORG board when they joined one (the brief: running the
  // command always ends up on the org leaderboard), else a friends board, else
  // their own dashboard — see resolveOpenTarget.
  const { baseUrl, target } = resolveOpenTarget(result, anonKey);
  // The dashboard/board URL comes BACK from the server. Only auto-open it if it's a real
  // https URL on our own web host — a malicious or MITM'd response must never make us
  // launch an arbitrary URL/scheme/handler. Otherwise show it as text; never auto-open.
  const trusted = isTrustedWebUrl(baseUrl);
  if (!flags.quiet) {
    // No burn report in the terminal. Reassure on security, then hand the user
    // straight to the browser where the dashboard summarises everything — and
    // tell them the one next step (sign in + add X) that gets them on the board.
    console.log(
      pc.green("  ✓ Synced securely.") +
        pc.dim(" Only your daily totals left this machine — never your prompts, code, or file names."),
    );
    if (trusted) {
      console.log(pc.dim("  Opening your dashboard in your browser…"));
      openBrowser(target);
    } else {
      console.log(
        pc.dim("  The server returned an unexpected dashboard address, so it was NOT auto-opened. Open it yourself only if you trust it:"),
      );
      console.log(`  ${sanitizeServerText(baseUrl)}`);
    }
  }
  // Destination + the single next step (sign in + add X). No usage numbers —
  // the dashboard summarises the burn. Built by a pure helper so it stays testable.
  const lines = submitNextStepLines(result);
  for (const line of lines) {
    // Emphasise the call-to-action arrow line; dim the management hint.
    if (line.includes("→")) console.log(pc.bold(line));
    else if (line.startsWith("  Private until you do")) {
      if (!flags.quiet) console.log(pc.dim(line));
    } else console.log(line);
  }

  // Keep the dashboard live by default: heal-on-run. On a normal run, reconcile the
  // background sync — install it if absent, AND reinstall it if the installed agent
  // has drifted from what the current CLI expects (stale interval, dead node path,
  // changed script path). This is what makes a config change actually re-apply to
  // an already-installed machine instead of silently sticking with the old plist.
  // Best-effort — a scheduler hiccup or unsupported OS must never fail a submit.
  if (!flags.quiet) {
    try {
      reconcileAutoSync();
    } catch {
      // ignore — the submit already succeeded; user can `install-sync` manually.
    }
  }

  if (!flags.quiet) {
    console.log();
    console.log(
      autoSyncInstalled()
        ? pc.dim("  Background sync is on — your page updates automatically every 15 min (`npx whoburnedmore uninstall-sync` to stop).")
        : pc.dim("  Re-run anytime to update your page."),
    );
  }
}

async function linkServerInstall(token: string | undefined): Promise<void> {
  if (!token) {
    throw new Error("missing install token — use `npx whoburnedmore link --token=<token>`");
  }
  const anonKey = ensureAnonKey();
  const linked = await redeemServerInstall(token, anonKey);
  const handle = sanitizeServerText(linked.handle);
  console.log(
    linked.alreadyLinked
      ? `  This machine is already linked to @${handle}.`
      : `  Linked this machine to @${handle}.`,
  );
  if (linked.mergedDays > 0) {
    console.log(pc.dim(`  Merged ${linked.mergedDays} existing usage day${linked.mergedDays === 1 ? "" : "s"} from this machine.`));
  }

  await run({
    dryRun: false,
    noSubmit: false,
    local: false,
    quiet: true,
  });

  try {
    const action = reconcileAutoSync();
    if (action === "installed") {
      console.log(pc.dim("  Background sync installed; this machine will refresh every 15 min."));
    } else if (action === "reinstalled") {
      console.log(pc.dim("  Background sync repaired; this machine will refresh every 15 min."));
    } else {
      console.log(pc.dim("  Background sync is already configured."));
    }
  } catch {
    console.log(pc.dim("  Linked, but background sync could not be installed automatically. Run `npx whoburnedmore install-sync` to retry."));
  }

  console.log(`  Profile: ${sanitizeServerText(linked.profileUrl)}`);
}

/** Sleep for `ms`, resolving early if `signal` aborts (prompt SIGTERM exit). */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Foreground sync loop for VMs/containers without a usable OS scheduler. Runs a
 * quiet collect+submit immediately, then every 15 min, until SIGINT/SIGTERM —
 * the portable way to keep a server on the leaderboard when cron/launchd/systemd
 * aren't an option. Meant to be supervised (systemd service, Docker CMD, pm2,
 * nohup); set WHOBURNEDMORE_CONFIG_DIR to a persistent path so the machine
 * identity survives container restarts.
 */
async function runDaemon(): Promise<void> {
  // A fresh VM may go straight to `daemon` without ever running once, so make
  // sure this machine has an identity to own its dashboard.
  ensureAnonKey();

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log(pc.bold("  whoburnedmore daemon"));
  console.log(
    pc.dim(
      `  Syncing in the foreground every ${syncIntervalLabel()} — run this under systemd, a Docker CMD, pm2 or nohup to keep a server on the leaderboard. Ctrl-C to stop.`,
    ),
  );
  if (!process.env.WHOBURNEDMORE_CONFIG_DIR) {
    console.log(
      pc.dim(
        "  Tip: set WHOBURNEDMORE_CONFIG_DIR to a persistent path so this machine's identity survives container/VM restarts.",
      ),
    );
  }
  console.log();

  const cycles = await daemonLoop({
    intervalMs: SYNC_INTERVAL_MINUTES * 60_000,
    isStopped: () => controller.signal.aborted,
    log: (line) => console.log(`  ${pc.dim(new Date().toISOString())}  ${line}`),
    wait: (ms) => waitOrAbort(ms, controller.signal),
    runOnce: async () => {
      rotateLogIfLarge();
      await run({ dryRun: false, noSubmit: false, local: false, quiet: true });
    },
  });

  console.log();
  console.log(pc.dim(`  Daemon stopped after ${cycles} sync cycle${cycles === 1 ? "" : "s"}.`));
}

async function main(): Promise<void> {
  loadEnv();
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(`whoburnedmore needs Node 20+ (you have ${process.versions.node})`);
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  const baseCommand = resolveCommand(args);
  // `--watch` on a run/sync promotes to the long-running daemon, so a server can
  // start it the same way it'd start a one-off (`whoburnedmore sync --watch`).
  const command =
    args.includes("--watch") && (baseCommand === "run" || baseCommand === "sync")
      ? "daemon"
      : baseCommand;
  const flags: Flags = {
    dryRun: args.includes("--dry-run"),
    noSubmit: args.includes("--no-submit"),
    local: args.includes("--local"),
    quiet: command === "sync",
    board: parseBoard(args),
    org: parseOrg(args),
    orgCode: parsePass(args),
  };

  switch (command) {
    case "run":
      await run(flags);
      break;
    case "sync": {
      // Background sync only runs once this machine has an anonymous key from a
      // prior run; otherwise it stays silent.
      if (!loadConfig()) return;
      // Keep launchd's append-only log from growing without bound.
      rotateLogIfLarge();
      await run({ ...flags, noSubmit: false, dryRun: false, local: false });
      break;
    }
    case "link":
      await linkServerInstall(parseInstallToken(args));
      break;
    case "daemon":
      await runDaemon();
      break;
    case "status":
    case "doctor": {
      for (const line of agentStatusReport()) console.log(line);
      break;
    }
    case "private":
    case "public": {
      const cfg = loadConfig();
      if (!cfg?.anonKey) {
        console.log("  No anonymous dashboard on this machine — run `npx whoburnedmore` first.");
        break;
      }
      await anonVisibility(cfg.anonKey, command === "public");
      console.log(
        command === "public"
          ? "  Your dashboard is public on the leaderboard again."
          : "  Your dashboard is now private — off the public leaderboard.",
      );
      break;
    }
    case "remove": {
      const cfg = loadConfig();
      if (!cfg?.anonKey) {
        console.log("  No anonymous dashboard on this machine — nothing to remove.");
        break;
      }
      await anonRemove(cfg.anonKey);
      console.log("  Removed your anonymous dashboard and all its data.");
      break;
    }
    case "install-sync":
      console.log(`  ${installAutoSync()}`);
      break;
    case "uninstall-sync":
      console.log(`  ${uninstallAutoSync()}`);
      break;
    case "help":
      printHelp();
      break;
    case "version":
      console.log(VERSION);
      break;
    default:
      console.error(`unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`
  ${pc.bold("whoburnedmore")} — who burned more tokens, you or them?

  ${pc.bold("usage")}
    npx whoburnedmore              burn + land on the public leaderboard, open your dashboard
    npx whoburnedmore --board=CODE compare with friends — join their board (no sign-in)
    npx whoburnedmore --org=SLUG   submit to your organization's board (companies/hackathons)
    npx whoburnedmore --local      build the dashboard on your machine and open it (offline)
    npx whoburnedmore --dry-run    print exactly what would be sent, send nothing
    npx whoburnedmore --no-submit  collect locally, send nothing (no dashboard)
    npx whoburnedmore link --token=TOKEN  link this server/VM to your signed-in account
    npx whoburnedmore daemon       keep syncing in the foreground (VMs/containers with no cron)
    npx whoburnedmore private      hide your dashboard from the leaderboard
    npx whoburnedmore public       put it back on the leaderboard
    npx whoburnedmore remove       delete your dashboard and its data
    npx whoburnedmore status       check background-sync health (last sync, staleness)
    npx whoburnedmore uninstall-sync   turn off the background sync
    npx whoburnedmore install-sync     turn it back on after uninstalling

  Background sync is on by default: after your first run, your page refreshes
  automatically every 15 min (\`uninstall-sync\` to stop). Your dashboard is public on
  the leaderboard as an anonymous burner — sign in on whoburnedmore.com to claim
  it (handle + X) and own your rank, or run \`private\`/\`remove\` to pull it. Only
  daily aggregate numbers (date, tool, model, token counts, est. cost) ever leave
  your machine — never prompts, code, or file names. With --local, nothing leaves
  your machine at all.

  ${pc.bold("servers & VMs")}
    Generate a one-time \`link\` command from your profile on whoburnedmore.com and
    run it inside the VM to bind that machine to your account. On a persistent VM
    background sync uses cron or a systemd user timer automatically; in a container
    or any host without a scheduler, run \`whoburnedmore daemon\` under your process
    manager instead. Set WHOBURNEDMORE_CONFIG_DIR to a persistent path so the
    machine identity survives restarts. See docs/SERVER-VM-SETUP.md.
`);
}

main().catch((err: Error) => {
  console.error(pc.red(`\n  ${err.message}\n`));
  process.exitCode = 1;
});
