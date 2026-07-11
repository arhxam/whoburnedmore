#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { SubmitPayload, VerifyRequestRecord } from "./shared.js";
import {
  applyScope,
  parseBoard,
  parseInstallToken,
  parseOrg,
  parsePass,
  resolveCommand,
} from "./args.js";
import {
  bindDeviceKey,
  deviceStart,
  devicePoll,
  refreshCliToken,
  removeUsage,
  setVisibility,
  submit as submitSignedInUsage,
  apiBase,
  webBase,
  isTrustedWebUrl,
  isOpenableUrl,
  redeemServerInstall,
  verifyUsage,
  UnauthorizedError,
} from "./api.js";
import {
  autoSyncInstalled,
  installAutoSync,
  reconcileAutoSync,
  rotateLogIfLarge,
  syncIntervalLabel,
  SYNC_INTERVAL_MINUTES,
  uninstallAutoSync,
} from "./autosync.js";
import { printBanner } from "./banner.js";
import { daemonLoop } from "./daemon.js";
import { collectAll, type ProgressFn } from "./collect.js";
import { collectClaudeRequests } from "./native/claude.js";
import {
  clearAuth,
  defaultConfigDir,
  ensureAnonKey,
  loadConfig,
  recordDeviceBound,
  recordSync,
  saveAuth,
} from "./config.js";
import { agentStatusReport } from "./status.js";
import { renderDashboardHtml } from "./local-dashboard.js";
import { sanitizeServerText, signedInNextStepLines } from "./output.js";
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
    renderDashboardHtml(payload.entries, new Date(), { webBaseUrl: webBase() }),
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
    // --local stays offline by default, but offer to publish from here. The
    // anonymous publish path is retired, so publishing = sign in + the same
    // authenticated submit a normal run does (plus the rotation-proofing
    // bookkeeping, so this machine self-heals like any signed-in one).
    if (!flags.quiet && process.stdin.isTTY) {
      await publishLocal(payload, {
        confirm,
        signIn: ensureSignedIn,
        submit: async (token, p) => {
          const result = await submitSignedInUsage(token, p);
          try {
            recordSync();
          } catch {
            /* best-effort */
          }
          try {
            const cfgNow = loadConfig();
            if (!cfgNow?.deviceBoundAt) {
              const key = ensureAnonKey();
              if (await bindDeviceKey(token, key)) recordDeviceBound();
            }
          } catch {
            /* best-effort */
          }
          return result;
        },
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

  // Submission requires a SIGNED-IN account. The CLI authenticates with a
  // server-issued token from the device sign-in flow, so a fabricated POST can
  // no longer land usage on someone's account. Resolution order:
  //   1. a stored CLI token  → authenticated /v1/submit
  //   2. a bound device key (claim / server-install / post-sign-in bind) → mint
  //      a fresh token silently, so a dead token never strands a machine
  //   3. fresh machine, a person at the keyboard → sign in first, then submit
  //   4. fresh machine, unattended → stay silent (never prompt, never mint anon)
  const cfg = loadConfig();
  // Sign-in is only attempted in a foreground run on a real terminal. The device
  // flow doesn't read stdin (approval happens in the browser), but we still gate
  // on a TTY so a non-interactive foreground run (CI/piped) doesn't hang polling
  // for the code's full lifetime. quiet ⇒ background (sync/daemon/link).
  const canSignIn = !flags.quiet && Boolean(process.stdout.isTTY);

  if (cfg?.cliToken) {
    await submitSignedIn(cfg.cliToken, payload, flags, canSignIn);
    return;
  }

  // No stored token. Before involving a human (or giving up in the background),
  // try the SILENT path: a machine whose device key is bound to an account can
  // mint a fresh token on its own. This is what resurrects an unattended
  // background sync whose token died — e.g. a server-side JWT secret rotation
  // 401'd every machine at once and the 401 handler cleared the stored token —
  // without anyone touching the machine.
  const healed = cfg?.anonKey ? await refreshCliToken(cfg.anonKey) : null;
  if (healed) {
    saveAuth(undefined, { cliToken: healed.token, handle: healed.handle });
    await submitSignedIn(healed.token, payload, flags, canSignIn);
  } else if (canSignIn) {
    const auth = await ensureSignedIn();
    if (!auth) return; // sign-in aborted/timed out — nothing submitted
    await submitSignedIn(auth.token, payload, flags, canSignIn);
  } else if (!flags.quiet) {
    // Foreground but no usable terminal (CI/piped) and no signed-in token — we
    // can't run the browser sign-in here. The anonymous / device-key submit path
    // has been retired (server returns 410), so point the way instead of writing
    // usage unauthenticated. A machine that has only a legacy device key falls
    // here too: re-link to get an authenticated token.
    console.log(pc.yellow("  Sign in to put your usage on the leaderboard."));
    console.log(
      pc.dim(
        "  Run `npx whoburnedmore` in an interactive terminal to sign in, or `npx whoburnedmore link --token=…` (from your signed-in profile) for servers/CI.",
      ),
    );
  } else {
    // Background with no signed-in token: stay completely silent — never prompt,
    // never submit unauthenticated.
    return;
  }
}

/** Sleep for `ms`. Used to pace device-token polling. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Try the silent device-key token refresh using this machine's stored key. */
async function refreshCliTokenFromConfig(): Promise<{
  token: string;
  handle: string;
} | null> {
  const cfg = loadConfig();
  if (!cfg?.anonKey) return null;
  return refreshCliToken(cfg.anonKey);
}

/**
 * Interactive device sign-in. Returns a stored token immediately if present;
 * otherwise starts the device flow — prints the user code, opens the web verify
 * page, and polls until the signed-in user approves it — then persists and
 * returns the token. Returns null if it times out or the user never approves.
 * Only call this with a TTY; background runs must never reach it.
 */
async function ensureSignedIn(): Promise<{ token: string; handle: string } | null> {
  const cfg = loadConfig();
  if (cfg?.cliToken) return { token: cfg.cliToken, handle: cfg.handle ?? "" };

  let dev;
  try {
    dev = await deviceStart();
  } catch (err) {
    console.log(pc.yellow(`  Couldn't start sign-in: ${(err as Error).message}`));
    return null;
  }

  console.log();
  console.log(pc.bold("  Sign in to whoburnedmore to put your usage on the board."));
  console.log(`  1. Opening ${pc.cyan(sanitizeServerText(dev.verifyUrl))} — or go there yourself.`);
  console.log(`  2. Approve this code: ${pc.bold(sanitizeServerText(dev.userCode))}`);
  // Only auto-open a verify URL that's genuinely on our own web host (guards a
  // hostile/MITM'd API response); otherwise the printed URL above is the fallback.
  if (isTrustedWebUrl(dev.verifyUrl)) openBrowser(dev.verifyUrl);
  console.log(pc.dim("  Waiting for you to approve in the browser…"));

  const deadline = Date.now() + dev.expiresInSeconds * 1000;
  const intervalMs = Math.max(1, dev.pollIntervalSeconds) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let res;
    try {
      res = await devicePoll(dev.deviceCode);
    } catch {
      continue; // transient network blip — keep polling until the deadline
    }
    if (res.status === "ok") {
      saveAuth(undefined, { cliToken: res.token, handle: res.handle });
      console.log(pc.green(`  ✓ Signed in as @${sanitizeServerText(res.handle)}.`));
      return { token: res.token, handle: res.handle };
    }
    if (res.status === "expired") break;
  }
  console.log(
    pc.yellow("  Sign-in timed out. Run `npx whoburnedmore` again to retry."),
  );
  return null;
}

/**
 * Submit as a signed-in user via the authenticated /v1/submit path. On a 401 the
 * stored token is expired/invalid: first try the SILENT recovery (mint a fresh
 * token from this machine's bound device key — survives server-side JWT secret
 * rotations with zero human involvement), then, if interactive, re-sign-in once
 * and retry; unattended and unhealable, give up quietly (the next interactive
 * run re-auths).
 */
async function submitSignedIn(
  token: string,
  payload: SubmitPayload,
  flags: Flags,
  interactive: boolean,
): Promise<void> {
  let activeToken = token;
  let result;
  try {
    result = await submitSignedInUsage(token, payload);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      const healed = await refreshCliTokenFromConfig();
      if (healed) {
        saveAuth(undefined, { cliToken: healed.token, handle: healed.handle });
        activeToken = healed.token;
        result = await submitSignedInUsage(healed.token, payload);
      } else {
        clearAuth();
        if (!interactive) return; // background can't re-auth — stay silent
        const auth = await ensureSignedIn();
        if (!auth) return;
        activeToken = auth.token;
        result = await submitSignedInUsage(auth.token, payload);
      }
    } else {
      throw err;
    }
  }

  try {
    recordSync();
  } catch {
    /* best-effort — never fail a submit over a freshness stamp */
  }

  // One-time per machine: bind this machine's device key to the account so a
  // future dead token can self-heal (see the 401 branch above). Machines that
  // onboarded through the browser device flow hold no server-verifiable secret
  // without this — a JWT rotation would strand them until a human re-runs the
  // CLI. Stamped only on a definitive server answer; network blips retry on a
  // later submit. Never lets a bookkeeping failure break a successful submit.
  try {
    const cfgNow = loadConfig();
    if (!cfgNow?.deviceBoundAt) {
      const key = ensureAnonKey();
      if (await bindDeviceKey(activeToken, key)) recordDeviceBound();
    }
  } catch {
    /* best-effort */
  }

  // Signed-in users are already on the board, so there's no claim handoff —
  // open the org board, friends board, or their profile directly.
  const baseUrl = result.orgBoardUrl ?? result.boardUrl ?? result.profileUrl;
  if (!flags.quiet) {
    console.log(
      pc.green("  ✓ Synced securely.") +
        pc.dim(" Only your daily totals left this machine — never your prompts, code, or file names."),
    );
    // Delisted? Surface it right here and offer the one-step fix in the same
    // session — the user is already signed in and at the keyboard, so this turns
    // "discover you're gone → hunt for the fix → open a terminal" into one prompt.
    if (result.suppressed) {
      console.log();
      console.log(
        pc.yellow(
          "  ⚠ You're currently OFF the leaderboard — we couldn't verify these numbers.",
        ),
      );
      console.log(
        pc.dim(
          "  Verify your usage to get back on — this sends a detailed per-request breakdown (timestamps + token counts, never your prompts or code).",
        ),
      );
      if (process.stdin.isTTY && (await confirm("  Verify now?"))) {
        await runVerify();
        afterSubmitChores(flags);
        return;
      }
      console.log(
        pc.dim(
          "  Run `npx whoburnedmore verify` anytime, or appeal at whoburnedmore.com/appeal.",
        ),
      );
    }
    // Name any days the anomaly screen pulled off the board on this run. The rows
    // are kept (recoverable) — this makes the removal visible instead of silent,
    // so a genuine breakout day the two-key rule caught can be contested.
    if (result.quarantinedDates && result.quarantinedDates.length > 0) {
      const days = result.quarantinedDates
        .map((d) => sanitizeServerText(d))
        .join(", ");
      console.log();
      console.log(
        pc.yellow(
          `  ⚠ These day(s) were held off the leaderboard as an anomaly: ${days}`,
        ),
      );
      console.log(
        pc.dim(
          "  Your data is kept, not deleted. Run `npx whoburnedmore verify` to get back on the board, or appeal at whoburnedmore.com/appeal to have these days reviewed and restored.",
        ),
      );
    }
    if (isTrustedWebUrl(baseUrl)) {
      console.log(pc.dim("  Opening your dashboard in your browser…"));
      openBrowser(baseUrl);
    } else {
      console.log(
        pc.dim("  The server returned an unexpected dashboard address, so it was NOT auto-opened. Open it yourself only if you trust it:"),
      );
      console.log(`  ${sanitizeServerText(baseUrl)}`);
    }
    for (const line of signedInNextStepLines(result)) {
      if (line.includes("→")) console.log(pc.bold(line));
      else console.log(line);
    }
  }
  afterSubmitChores(flags);
}

/**
 * Post-submit housekeeping shared by both submit paths: heal-on-run reconcile of
 * the background sync (install if absent, repair if drifted) and the one-line
 * background-sync status footer. Best-effort — never fails an already-good submit.
 */
function afterSubmitChores(flags: Flags): void {
  if (flags.quiet) return;
  try {
    reconcileAutoSync();
  } catch {
    // ignore — the submit already succeeded; user can `install-sync` manually.
  }
  console.log();
  console.log(
    autoSyncInstalled()
      ? pc.dim("  Background sync is on — your page updates automatically every 15 min (`npx whoburnedmore uninstall-sync` to stop).")
      : pc.dim("  Re-run anytime to update your page."),
  );
}

async function linkServerInstall(token: string | undefined): Promise<void> {
  if (!token) {
    throw new Error("missing install token — use `npx whoburnedmore link --token=<token>`");
  }
  const anonKey = ensureAnonKey();
  const linked = await redeemServerInstall(token, anonKey);
  // Store the authenticated CLI token the server issues so subsequent runs submit
  // via /v1/submit (the anon device-key submit path has been retired).
  if (linked.cliToken) {
    saveAuth(undefined, { cliToken: linked.cliToken, handle: linked.handle });
  }
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

/**
 * Re-verify a delisted account (`whoburnedmore verify`). Reads the local
 * per-request skeleton (timestamps + token counts, NEVER content), uploads it to
 * the authenticated /v1/verify endpoint, and reports the verdict — relisted, kept
 * off pending a human, or rejected. Requires sign-in (it's tied to the account
 * that was delisted).
 */
async function runVerify(): Promise<void> {
  printBanner();
  console.log();
  console.log(pc.bold("  Verify your usage to get back on the leaderboard."));
  console.log(
    pc.dim(
      "  This sends a DETAILED per-request breakdown — timestamps and token counts, still never your prompts, code, or file names — so we can confirm your usage is real. It's deleted after review.",
    ),
  );

  // Verify is tied to the delisted account, so it requires sign-in.
  const cfg = loadConfig();
  let token = cfg?.cliToken;
  if (!token) {
    if (!process.stdout.isTTY) {
      console.log(
        pc.yellow(
          "  Sign in first — run `npx whoburnedmore verify` in an interactive terminal.",
        ),
      );
      return;
    }
    const auth = await ensureSignedIn();
    if (!auth) return;
    token = auth.token;
  }

  if (process.stdin.isTTY) {
    const ok = await confirm("\n  Send this breakdown to verify your usage?");
    if (!ok) {
      console.log(pc.dim("  Cancelled — nothing was sent."));
      return;
    }
  }

  console.log(pc.dim("  Reading your local Claude Code logs…"));
  const { requests, found } = await collectClaudeRequests();
  if (!found || requests.length === 0) {
    console.log(
      pc.yellow("  No local Claude Code logs found on this machine to verify."),
    );
    console.log(
      pc.dim(
        "  Run this on the machine where you actually use Claude Code, or file a written appeal at whoburnedmore.com/appeal.",
      ),
    );
    return;
  }

  // Bound the upload: send the most-recent CAP requests, flag truncation so the
  // server treats a sampled upload conservatively.
  const CAP = 50_000;
  const sorted = requests.slice().sort((a, b) => b.ts - a.ts);
  const truncated = sorted.length > CAP;
  const capped = truncated ? sorted.slice(0, CAP) : sorted;
  const records: VerifyRequestRecord[] = capped.map((r) => ({
    date: r.date,
    ts: r.ts,
    tool: "claude",
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    cacheReadTokens: r.cacheReadTokens,
    reqHash: createHash("sha256").update(r.key).digest("hex").slice(0, 32),
  }));

  console.log(
    pc.dim(
      `  Sending ${records.length} request records for analysis${truncated ? " (most recent, sampled)" : ""}…`,
    ),
  );
  let result;
  try {
    result = await verifyUsage(token, {
      cliVersion: VERSION,
      requests: records,
      ...(truncated ? { truncated: true } : {}),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      clearAuth();
      console.log(
        pc.yellow(
          "  Your sign-in expired — run `npx whoburnedmore verify` again to retry.",
        ),
      );
      return;
    }
    throw err;
  }

  console.log();
  const line = `  ${sanitizeServerText(result.message)}`;
  if (result.relisted) {
    console.log(pc.green(`  ✓${line.slice(1)}`));
  } else {
    console.log(result.verdict === "fail" ? pc.yellow(line) : line);
    console.log(
      pc.dim(
        "  We'll relist you automatically if it checks out — re-run `npx whoburnedmore` anytime to check.",
      ),
    );
  }
}

/**
 * Resolve a signed-in CLI token for a self-management command: stored token →
 * silent device-key refresh → interactive device sign-in (TTY only). Returns
 * null (after printing guidance) when the machine can't authenticate here.
 */
async function requireSignedIn(
  commandName: string,
): Promise<{ token: string; handle: string } | null> {
  const cfg = loadConfig();
  if (cfg?.cliToken) return { token: cfg.cliToken, handle: cfg.handle ?? "" };
  const healed = await refreshCliTokenFromConfig();
  if (healed) {
    saveAuth(undefined, { cliToken: healed.token, handle: healed.handle });
    return healed;
  }
  if (process.stdout.isTTY) return ensureSignedIn();
  console.log(
    pc.yellow(
      `  Sign in first — run \`npx whoburnedmore ${commandName}\` in an interactive terminal.`,
    ),
  );
  return null;
}

/** `npx whoburnedmore private` / `public`: flip the leaderboard listing. */
async function runVisibility(listed: boolean): Promise<void> {
  const auth = await requireSignedIn(listed ? "public" : "private");
  if (!auth) return;
  let res;
  try {
    res = await setVisibility(auth.token, listed);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      clearAuth();
      console.log(
        pc.yellow(
          `  Your sign-in expired — run \`npx whoburnedmore ${listed ? "public" : "private"}\` again to retry.`,
        ),
      );
      return;
    }
    throw err;
  }
  if (!listed) {
    console.log("  ✓ You're off the public leaderboard. `npx whoburnedmore public` puts you back.");
    return;
  }
  if (res.listed) {
    console.log("  ✓ You're back on the public leaderboard.");
  } else if (!res.eligible) {
    console.log(
      pc.yellow("  You're signed in, but not on the leaderboard yet — it lists accounts with a social handle."),
    );
    console.log(
      pc.dim("  Add your X, GitHub or Instagram on your profile at whoburnedmore.com, then you're on."),
    );
  } else {
    console.log("  ✓ Leaderboard listing is on.");
  }
}

/**
 * `npx whoburnedmore remove`: delete the signed-in account's usage data from
 * the leaderboard. Confirms on a TTY and refuses without one; also turns off
 * this machine's background sync (else the next 15-min tick would resubmit the
 * full local snapshot) and drops the local sign-in. Account deletion itself
 * lives on the web dashboard — a machine token can't destroy the account.
 */
async function runRemove(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(
      pc.yellow("  `remove` deletes data, so it needs an interactive terminal to confirm."),
    );
    console.log(pc.dim("  Run `npx whoburnedmore remove` in a real terminal."));
    process.exitCode = 1;
    return;
  }
  const auth = await requireSignedIn("remove");
  if (!auth) return;
  const who = auth.handle ? `@${sanitizeServerText(auth.handle)}` : "your account";
  console.log(
    `  This deletes ALL usage data stored for ${who} on whoburnedmore.com and turns off this machine's background sync.`,
  );
  console.log(
    pc.dim("  Your local logs are untouched, and the account itself survives (delete it from your dashboard settings on the web)."),
  );
  if (!(await confirm("  Delete your usage data?"))) {
    console.log(pc.dim("  Cancelled — nothing was deleted."));
    return;
  }
  let res;
  try {
    res = await removeUsage(auth.token);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      clearAuth();
      console.log(
        pc.yellow("  Your sign-in expired — run `npx whoburnedmore remove` again to retry."),
      );
      return;
    }
    throw err;
  }
  try {
    uninstallAutoSync();
  } catch {
    /* best-effort — the deletion already happened; sync would just re-add data */
  }
  clearAuth();
  console.log(
    pc.green(`  ✓ Deleted your usage data (${res.deletedDays} day${res.deletedDays === 1 ? "" : "s"}) and turned off background sync.`),
  );
  console.log(pc.dim("  Run `npx whoburnedmore` anytime to start fresh."));
}

async function main(): Promise<void> {
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
    case "verify":
      await runVerify();
      break;
    case "status":
    case "doctor": {
      for (const line of agentStatusReport()) console.log(line);
      break;
    }
    case "private":
    case "public":
      await runVisibility(command === "public");
      break;
    case "remove":
      await runRemove();
      break;
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
    npx whoburnedmore              sign in, burn + land on the public leaderboard, open your dashboard
    npx whoburnedmore --board=CODE compare with friends — sign in and join their board
    npx whoburnedmore --org=SLUG --pass=CODE  join your organization's board (companies/hackathons)
    npx whoburnedmore --local      build the dashboard on your machine and open it (offline)
    npx whoburnedmore --dry-run    print exactly what would be sent, send nothing
    npx whoburnedmore --no-submit  collect locally, send nothing (no dashboard)
    npx whoburnedmore link --token=TOKEN  link this server/VM to your signed-in account
    npx whoburnedmore daemon       keep syncing in the foreground (VMs/containers with no cron)
    npx whoburnedmore private      take yourself off the public leaderboard
    npx whoburnedmore public       put yourself back on it
    npx whoburnedmore remove       delete your usage data and stop background sync
    npx whoburnedmore verify       delisted? re-verify your usage to get back on (sends a detailed breakdown)
    npx whoburnedmore status       check background-sync health (last sync, staleness)
    npx whoburnedmore uninstall-sync   turn off the background sync
    npx whoburnedmore install-sync     turn it back on after uninstalling

  Your first run signs you in (we open a page, you approve a short code) and binds
  this machine to your account — your usage lands on the leaderboard under your
  handle. Background sync is on by default: your page then refreshes automatically
  every 15 min (\`uninstall-sync\` to stop); run \`private\`/\`remove\` to pull it. Only
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
