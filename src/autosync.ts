import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, win32 } from "node:path";
import { defaultConfigDir } from "./config.js";

/**
 * How often the background agent re-collects usage and submits it. Dropped from
 * 60min → 15min on 2026-06-21 so a dev's leaderboard rank, daily burn and streak
 * stay near-live without them re-running the command by hand. Submits are
 * idempotent server-side and a collect is light (~15s, background priority), so a
 * tighter cadence costs the machine almost nothing. Expressed in MINUTES because
 * launchd/cron/schtasks all need sub-hour granularity now.
 */
export const SYNC_INTERVAL_MINUTES = 15;
/** Human label for the interval, e.g. "15m" or "1h". Used in install messages. */
export function syncIntervalLabel(mins: number = SYNC_INTERVAL_MINUTES): string {
  return mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}
const LABEL = "com.whoburnedmore.sync";

/**
 * Stable node locations to prefer over `process.execPath`. The launchd plist
 * captures the node binary path at install time; `process.execPath` on a Homebrew
 * machine is a *version-pinned* Cellar path
 * (`/opt/homebrew/Cellar/node/<ver>/bin/node`) that vanishes on the next
 * `brew upgrade node`, leaving the agent unable to launch — silently, with no log.
 * These symlinks survive node upgrades, so the agent keeps working.
 */
const STABLE_NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

const STABLE_NPM_CANDIDATES = [
  "/opt/homebrew/bin/npm",
  "/usr/local/bin/npm",
  "/usr/bin/npm",
];

const LATEST_PACKAGE_SPEC = "whoburnedmore@latest";

/**
 * Standard executable directories to fold into the background-sync PATH. OS
 * schedulers (launchd, cron, systemd) run jobs with a stripped-down environment
 * — launchd's is just `/usr/bin:/bin:/usr/sbin:/sbin`, which excludes both
 * Homebrew dirs. Our plist invokes `npm`, and npm's shebang is
 * `#!/usr/bin/env node`; `npm exec` then spawns the package bin, whose shebang
 * is *also* `#!/usr/bin/env node`. With node off PATH every tick dies with
 * `env: node: No such file or directory` (exit 127) and the account stops
 * syncing silently. Including the Homebrew + /usr/local dirs (where node lives
 * on the vast majority of machines) makes `env node` resolve.
 */
const SYNC_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/**
 * The PATH to export into the scheduler environment so the npm we invoke (and
 * the node its shebang needs) resolve. Puts the directory of the resolved npm
 * binary first — that's where this machine's node actually lives — then the
 * standard dirs as a fallback. A bare/relative npm path (the `resolveNpmPath`
 * last-resort "npm"/"npm.cmd") contributes no directory, so `.` never leaks in.
 */
export function syncPathEnv(npmPath: string = resolveNpmPath()): string {
  const dir = dirname(npmPath);
  const dirs: string[] = [];
  if (dir && dir !== "." && dir !== "/" && dir !== npmPath) dirs.push(dir);
  for (const d of SYNC_PATH_DIRS) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  return dirs.join(":");
}

/**
 * Env vars whose presence in the user's shell changes WHO the agent is, WHERE it
 * submits, or WHAT it collects. The OS schedulers start the job with a clean
 * environment, so if the user set any of these in their shell profile the
 * background agent would silently diverge from the foreground command — e.g.
 * minting a *different* anonKey under the default config dir and submitting to a
 * separate, unclaimed dashboard while the user's real account never updates.
 * We capture whichever are set at install/reconcile time so background ==
 * foreground. (PATH is always set; see `syncPathEnv`.)
 */
const FORWARDED_ENV_VARS = [
  "WHOBURNEDMORE_CONFIG_DIR", // identity: where the anonKey lives
  "WHOBURNEDMORE_API", // endpoint: where submits go
  "WHOBURNEDMORE_WEB", // dashboard URL shown to the user
  "XDG_CONFIG_HOME", // base for the default config dir
  "CLAUDE_CONFIG_DIR", // a primary usage-collection source
];

/**
 * Ordered `[key, value]` environment pairs to bake into the scheduled job: PATH
 * first (so npm's `env node` shebang resolves), then any forwarded var that is
 * actually set. `env`/`npmPath` are injectable for tests. Deterministic for a
 * given process env, so install-time and drift-check content always match.
 */
export function syncEnv(opts?: {
  npmPath?: string;
  env?: NodeJS.ProcessEnv;
}): Array<[string, string]> {
  const env = opts?.env ?? process.env;
  const pairs: Array<[string, string]> = [["PATH", syncPathEnv(opts?.npmPath)]];
  for (const key of FORWARDED_ENV_VARS) {
    const value = env[key];
    // Skip empty/unset, and skip any value with a newline: cron and systemd are
    // line-oriented, so a `\n`/`\r` in a forwarded value would split the crontab
    // line / `Environment=` directive and silently break the agent. These vars
    // are paths and URLs that never legitimately contain a newline.
    if (typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value)) {
      pairs.push([key, value]);
    }
  }
  return pairs;
}

/**
 * Log inside the user's own config dir, not /tmp — a fixed /tmp path could
 * be pre-created as a symlink by another local user.
 */
export function syncLogPath(): string {
  return join(defaultConfigDir(), "sync.log");
}

export function buildLaunchdPlist(
  commandArgs: string[] = syncCommandArgs(),
  logPath: string = syncLogPath(),
  envPairs: Array<[string, string]> = syncEnv({ npmPath: commandArgs[0] }),
): string {
  const programArguments = commandArgs
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const envEntries = envPairs
    .map(
      ([k, v]) =>
        `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <!-- launchd runs jobs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin)
       that excludes Homebrew. npm's shebang (and the package bin npm exec
       spawns) is #!/usr/bin/env node, so node must be on PATH or every tick
       dies with "env: node: No such file or directory". We also forward the
       user's identity/endpoint/collection env so background == foreground. -->
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StartInterval</key>
  <integer>${SYNC_INTERVAL_MINUTES * 60}</integer>
  <!-- Run once right after login/reboot so a machine that was off (or asleep)
       through a scheduled tick catches up immediately, then keeps to the
       interval. Submits are idempotent server-side, so an extra run is safe. -->
  <key>RunAtLoad</key>
  <true/>
  <!-- Standard, NOT Background. ProcessType=Background opts the job into
       macOS I/O throttling, which is disastrous for a job whose work is almost
       entirely reading thousands of transcript files: a full collect measured
       ~51s unthrottled vs ~197s throttled on the same machine. That blows past
       the collector's own budgets (25s per ccusage child, 45s for the native
       reader), so every source times out at once, entries comes back empty and
       the tick submits nothing — it logged "Nothing to burn yet" on 206 of 473
       runs (~44%) until this was changed. Nice=0 keeps CPU priority neighbourly
       without throttling the reads. -->
  <key>ProcessType</key>
  <string>Standard</string>
  <key>Nice</key>
  <integer>0</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** True if `p` exists and runs `node -v` reporting major >= 20. */
function isUsableNode(p: string): boolean {
  if (!existsSync(p)) return false;
  const res = spawnSync(p, ["-v"], { encoding: "utf8" });
  if (res.status !== 0 || typeof res.stdout !== "string") return false;
  const major = Number(res.stdout.trim().replace(/^v/, "").split(".")[0]);
  return Number.isFinite(major) && major >= 20;
}

/**
 * Pick the node binary to bake into the background-sync schedule. Prefer a stable
 * symlink (see STABLE_NODE_CANDIDATES) that runs node >= 20, so the agent keeps
 * working across `brew upgrade node`; fall back to `process.execPath` only when no
 * stable candidate qualifies. `check`/`execPath` are injectable for tests.
 */
export function resolveNodePath(opts?: {
  candidates?: string[];
  check?: (p: string) => boolean;
  execPath?: string;
}): string {
  const candidates = opts?.candidates ?? STABLE_NODE_CANDIDATES;
  const check = opts?.check ?? isUsableNode;
  const execPath = opts?.execPath ?? process.execPath;
  for (const c of candidates) {
    if (check(c)) return c;
  }
  return execPath;
}

function isUsableNpm(p: string): boolean {
  if (!existsSync(p)) return false;
  const res = spawnSync(p, ["--version"], { encoding: "utf8" });
  return res.status === 0;
}

export function resolveNpmPath(opts?: {
  candidates?: string[];
  check?: (p: string) => boolean;
  execPath?: string;
  platform?: NodeJS.Platform | string;
}): string {
  const candidates = opts?.candidates ?? STABLE_NPM_CANDIDATES;
  const check = opts?.check ?? isUsableNpm;
  const execPath = opts?.execPath ?? process.execPath;
  const os = opts?.platform ?? platform();
  for (const c of candidates) {
    if (check(c)) return c;
  }

  const sibling = os === "win32"
    ? win32.join(win32.dirname(execPath), "npm.cmd")
    : join(dirname(execPath), "npm");
  if (check(sibling)) return sibling;

  return os === "win32" ? "npm.cmd" : "npm";
}

export function syncCommandArgs(npmPath: string = resolveNpmPath()): string[] {
  return [
    npmPath,
    "exec",
    "--yes",
    "--ignore-scripts",
    "--package",
    LATEST_PACKAGE_SPEC,
    "--",
    "whoburnedmore",
    "sync",
  ];
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll(">", "&gt;");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function windowsQuote(value: string): string {
  const escaped = value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/\\+$/g, (slashes) => `${slashes}${slashes}`);
  return `"${escaped}"`;
}

export function windowsCommandLine(args: string[]): string {
  return args.map(windowsQuote).join(" ");
}

/** The exact launchd plist this machine *should* have right now (darwin). */
export function expectedDarwinPlist(): string {
  return buildLaunchdPlist(syncCommandArgs());
}

export type DriftState = "absent" | "drift" | "ok";

/**
 * Pure drift check: compare the installed agent content against what we'd write
 * now. `absent` (nothing installed) and `drift` (content differs — e.g. a stale
 * 3600s StartInterval against the current 900s source, or a dead Cellar node path) both mean the
 * agent must be (re)installed; `ok` means leave it alone.
 */
export function plistDrift(installed: string | null, expected: string): DriftState {
  if (installed === null) return "absent";
  return installed.trim() === expected.trim() ? "ok" : "drift";
}

/** Map a drift state to the action the reconcile gate takes. */
export function reconcileAction(state: DriftState): "install" | "noop" {
  return state === "ok" ? "noop" : "install";
}

/** Install the background sync for the current platform. Returns a human description. */
export function installAutoSync(): string {
  const os = platform();
  mkdirSync(defaultConfigDir(), { recursive: true });
  if (os === "darwin") {
    const plistPath = launchAgentPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, expectedDarwinPlist());
    spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    spawnSync("launchctl", ["load", plistPath], { stdio: "ignore" });
    return `launchd agent installed (${plistPath}), syncing every ${syncIntervalLabel()}`;
  }
  if (os === "linux") {
    // Prefer cron (reconciled by content below); fall back to a systemd user
    // timer for the many VMs/containers that ship without crontab. If neither
    // is available, point the user at the portable foreground daemon instead of
    // dying silently — on a server that's the difference between tracking and not.
    const viaCron = tryInstallCron();
    if (viaCron) return viaCron;
    const viaSystemd = tryInstallSystemd();
    if (viaSystemd) return viaSystemd;
    throw new Error(
      "could not install background sync: no usable crontab or systemd user timer. " +
        "Run `whoburnedmore daemon` under your process manager (systemd service, Docker CMD, pm2 or nohup) to keep syncing.",
    );
  }
  if (os === "win32") {
    const res = spawnSync("schtasks", [
      "/Create", "/F",
      "/SC", "MINUTE",
      "/MO", String(SYNC_INTERVAL_MINUTES),
      "/TN", "whoburnedmore-sync",
      "/TR", windowsCommandLine(syncCommandArgs()),
    ]);
    if (res.status !== 0) throw new Error("could not create scheduled task");
    return `scheduled task installed, syncing every ${syncIntervalLabel()}`;
  }
  throw new Error(`auto-sync is not supported on ${os}`);
}

/** Cron schedule expression for the sync interval (sub-hour → minute field). */
export function cronSchedule(mins: number = SYNC_INTERVAL_MINUTES): string {
  return mins % 60 === 0 ? `0 */${mins / 60} * * *` : `*/${mins} * * * *`;
}

/** The exact crontab line this machine should have right now (linux). */
export function expectedLinuxCronLine(opts?: {
  npmPath?: string;
  logPath?: string;
}): string {
  const command = syncCommandArgs(opts?.npmPath)
    .map(shellQuote)
    .join(" ");
  // cron runs the line via /bin/sh with a bare PATH (usually /usr/bin:/bin);
  // export node's dir (and the user's identity/endpoint env) inline so npm's
  // `env node` shebang resolves and background submits as the same account.
  const envPrefix = syncEnv({ npmPath: opts?.npmPath ?? resolveNpmPath() })
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  const redirect = `>${shellQuote(opts?.logPath ?? syncLogPath())} 2>&1`;
  // cron turns an unescaped `%` in the command field into a newline (the rest
  // becomes stdin), so a path/value containing `%` would corrupt the line —
  // escape every `%` as `\%`; cron strips the backslash and hands `%` to sh.
  const commandField = `${envPrefix} ${command} ${redirect}`.replaceAll("%", "\\%");
  return `${cronSchedule()} ${commandField}`;
}

// --- systemd user-timer fallback (linux) ---------------------------------
//
// Many real VMs and most containers ship without a crontab binary (or a
// running cron daemon), so the cron path above silently buys nothing there.
// When cron is unavailable we fall back to a systemd *user* timer, which is
// present on virtually every modern Linux distro's default install. It is a
// genuine second mechanism, so the drift/reconcile machinery below is taught to
// recognise whichever one is actually installed and only heal that one.

const SYSTEMD_UNIT = "whoburnedmore-sync";

/** `~/.config/systemd/user`, honouring XDG_CONFIG_HOME the way systemd does. */
export function systemdUserDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "systemd", "user");
}
export function systemdServicePath(): string {
  return join(systemdUserDir(), `${SYSTEMD_UNIT}.service`);
}
export function systemdTimerPath(): string {
  return join(systemdUserDir(), `${SYSTEMD_UNIT}.timer`);
}

/**
 * systemd parses ExecStart/Environment with its OWN rules (not a shell):
 * whitespace splits args, double quotes group, backslash escapes — and `%` is a
 * specifier prefix (`%h`, `%i`, …) that must be doubled to mean a literal `%`.
 * So shell single-quoting is wrong here — wrap each value in double quotes,
 * escape `\` and `"`, and double any `%`.
 */
export function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "%%")
    .replaceAll("\"", "\\\"")}"`;
}

export function buildSystemdService(
  commandArgs: string[] = syncCommandArgs(),
  envPairs: Array<[string, string]> = syncEnv({ npmPath: commandArgs[0] }),
): string {
  const execStart = commandArgs.map(systemdQuote).join(" ");
  // systemd starts the unit with its own minimal PATH; npm's `env node` shebang
  // needs node's dir on it, and the user's identity/endpoint env must carry over
  // so background submits as the same account — same as the launchd plist.
  const envLines = envPairs
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=whoburnedmore background token-usage sync

[Service]
Type=oneshot
${envLines}
ExecStart=${execStart}
`;
}

export function buildSystemdTimer(mins: number = SYNC_INTERVAL_MINUTES): string {
  return `[Unit]
Description=whoburnedmore background token-usage sync timer

[Timer]
OnBootSec=1min
OnUnitActiveSec=${mins}min
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** True if `cmd` resolves to an executable (no ENOENT when spawned). */
function binaryExists(cmd: string, probeArgs: string[] = ["--version"]): boolean {
  const res = spawnSync(cmd, probeArgs, { stdio: "ignore" });
  return !res.error;
}

/**
 * Which linux mechanism currently owns the background sync, by inspection:
 * a `whoburnedmore` crontab line, or our installed systemd timer file, or none.
 * Cron wins when both are somehow present (it's the primary).
 */
export function linuxSyncMechanism(): "cron" | "systemd" | "none" {
  const cron = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (!cron.error && cron.status === 0 && cron.stdout.includes("whoburnedmore")) {
    return "cron";
  }
  if (existsSync(systemdTimerPath())) return "systemd";
  return "none";
}

/** Install the cron entry; returns a description, or null if cron is unusable. */
function tryInstallCron(): string | null {
  if (!binaryExists("crontab", ["-l"])) return null;
  const line = expectedLinuxCronLine();
  const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  const existing = current.status === 0 ? current.stdout : "";
  const kept = existing
    .split("\n")
    .filter((l) => !l.includes("whoburnedmore"))
    .join("\n");
  const next = `${kept.trimEnd()}\n${line}\n`.replace(/^\n+/, "");
  const res = spawnSync("crontab", ["-"], { input: next });
  if (res.status !== 0) return null;
  return `cron entry installed, syncing every ${syncIntervalLabel()}`;
}

/** Install a systemd user timer; returns a description, or null if unusable. */
function tryInstallSystemd(): string | null {
  if (!binaryExists("systemctl", ["--user", "--version"])) return null;
  try {
    mkdirSync(systemdUserDir(), { recursive: true });
    writeFileSync(systemdServicePath(), buildSystemdService());
    writeFileSync(systemdTimerPath(), buildSystemdTimer());
  } catch {
    return null;
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  const res = spawnSync(
    "systemctl",
    ["--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`],
    { stdio: "ignore" },
  );
  if (res.status !== 0) {
    // Files are written but the timer couldn't be enabled (e.g. no user DBus on
    // a bare container). Roll back so drift detection doesn't think a working
    // systemd timer exists.
    rmSync(systemdServicePath(), { force: true });
    rmSync(systemdTimerPath(), { force: true });
    return null;
  }
  return `systemd user timer installed, syncing every ${syncIntervalLabel()} (run \`loginctl enable-linger\` to keep syncing while logged out)`;
}

export function uninstallAutoSync(): string {
  const os = platform();
  if (os === "darwin") {
    const plistPath = launchAgentPath();
    if (existsSync(plistPath)) {
      spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
      rmSync(plistPath, { force: true });
    }
    return "launchd agent removed";
  }
  if (os === "linux") {
    let removed = false;
    const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
    if (!current.error && current.status === 0 && current.stdout.includes("whoburnedmore")) {
      const next = current.stdout
        .split("\n")
        .filter((l) => !l.includes("whoburnedmore"))
        .join("\n");
      spawnSync("crontab", ["-"], { input: next });
      removed = true;
    }
    if (existsSync(systemdTimerPath())) {
      spawnSync(
        "systemctl",
        ["--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`],
        { stdio: "ignore" },
      );
      rmSync(systemdServicePath(), { force: true });
      rmSync(systemdTimerPath(), { force: true });
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      removed = true;
    }
    return removed ? "background sync removed" : "nothing to remove";
  }
  if (os === "win32") {
    spawnSync("schtasks", ["/Delete", "/F", "/TN", "whoburnedmore-sync"]);
    return "scheduled task removed";
  }
  return "nothing to remove";
}

export function autoSyncInstalled(): boolean {
  if (platform() === "darwin") return existsSync(launchAgentPath());
  if (platform() === "linux") {
    return linuxSyncMechanism() !== "none";
  }
  if (platform() === "win32") {
    const res = spawnSync("schtasks", ["/Query", "/TN", "whoburnedmore-sync"], {
      stdio: "ignore",
    });
    return res.status === 0;
  }
  return false;
}

/** The installed systemd unit+timer content concatenated, or null if absent. */
function readInstalledSystemd(): string | null {
  try {
    return `${readFileSync(systemdServicePath(), "utf8")}\n${readFileSync(systemdTimerPath(), "utf8")}`;
  } catch {
    return null;
  }
}

/** What a correctly-installed systemd unit+timer should look like right now. */
function expectedSystemd(): string {
  return `${buildSystemdService()}\n${buildSystemdTimer()}`;
}

/** Read the currently-installed agent config as a string, or null if absent. */
function readInstalledAgent(): string | null {
  if (platform() === "darwin") {
    const p = launchAgentPath();
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  if (platform() === "linux") {
    // Read back whichever mechanism is actually installed so drift compares
    // like-for-like (and a systemd-only host isn't perpetually seen as "absent").
    const mech = linuxSyncMechanism();
    if (mech === "cron") {
      const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
      if (current.error || current.status !== 0) return null;
      return current.stdout.split("\n").find((l) => l.includes("whoburnedmore")) ?? null;
    }
    if (mech === "systemd") return readInstalledSystemd();
    return null;
  }
  return null;
}

/** What the installed agent *should* be on this platform, for drift comparison. */
function expectedAgent(): string | null {
  if (platform() === "darwin") return expectedDarwinPlist();
  if (platform() === "linux") {
    // Compare against the mechanism in play; an absent install defaults to the
    // cron target (install() tries cron first, then systemd).
    return linuxSyncMechanism() === "systemd" ? expectedSystemd() : expectedLinuxCronLine();
  }
  return null;
}

/** Current drift state of the background agent (darwin/linux). */
export function autoSyncDrift(): DriftState {
  const expected = expectedAgent();
  // Platforms we can't read back (win32) fall back to existence-only.
  if (expected === null) return autoSyncInstalled() ? "ok" : "absent";
  return plistDrift(readInstalledAgent(), expected);
}

/**
 * Heal-on-run: reinstall the background agent when it's absent OR has drifted
 * (stale interval, dead node path, changed script path), and leave it alone when
 * it already matches. Returns what it did. Callers wrap this best-effort — a
 * reconcile failure must never fail a submit.
 */
export function reconcileAutoSync(): "installed" | "reinstalled" | "noop" {
  const state = autoSyncDrift();
  if (reconcileAction(state) === "noop") return "noop";
  installAutoSync();
  return state === "absent" ? "installed" : "reinstalled";
}

/**
 * Keep launchd's append-only StandardOutPath from growing without bound: once the
 * log passes `capBytes`, roll it to `<path>.1` (overwriting any older roll) so a
 * fresh, small log starts on the next write. Best-effort and silent on error.
 */
export function rotateLogIfLarge(
  path: string = syncLogPath(),
  capBytes = 256 * 1024,
): boolean {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size <= capBytes) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

export function notifyLaunchLive(opts?: {
  platform?: NodeJS.Platform | string;
  spawn?: (cmd: string, args: string[]) => { status: number | null };
}): boolean {
  const os = opts?.platform ?? platform();
  const run = opts?.spawn ?? ((cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }));
  const title = "whoburnedmore is live";
  const message = "Your dashboard is ready. Go to whoburnedmore.com";

  if (os === "darwin") {
    return (
      run("osascript", [
        "-e",
        `display notification "${message}" with title "${title}"`,
      ]).status === 0
    );
  }
  if (os === "linux") {
    return run("notify-send", [title, message]).status === 0;
  }
  if (os === "win32") {
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Application",
      `$n.BalloonTipTitle = ${psQuote(title)}`,
      `$n.BalloonTipText = ${psQuote(message)}`,
      "$n.Visible = $true",
      "$n.ShowBalloonTip(10000)",
      "Start-Sleep -Seconds 2",
      "$n.Dispose()",
    ].join("; ");
    return (
      run("powershell", [
        "-NoProfile",
        "-Command",
        script,
      ]).status === 0
    );
  }
  return false;
}

/** True if the launchd/cron/schtasks job is currently loaded with the scheduler. */
export function autoSyncLoaded(): boolean {
  if (platform() === "darwin") {
    const res = spawnSync("launchctl", ["list"], { encoding: "utf8" });
    return res.status === 0 && res.stdout.includes(LABEL);
  }
  // On linux/win, "installed" == "loaded" (cron/schtasks have no separate state).
  return autoSyncInstalled();
}
