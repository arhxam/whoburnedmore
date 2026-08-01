import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdTimer,
  cronSchedule,
  expectedLinuxCronLine,
  plistDrift,
  reconcileAction,
  notifyLaunchLive,
  resolveNpmPath,
  resolveNodePath,
  syncCommandArgs,
  syncPathEnv,
  syncEnv,
  shellQuote,
  systemdQuote,
  windowsCommandLine,
  xmlEscape,
  rotateLogIfLarge,
  SYNC_INTERVAL_MINUTES,
  syncIntervalLabel,
} from "../src/autosync.js";

import path, { posix } from "node:path";

describe("buildLaunchdPlist", () => {
  it("produces a launchd plist that runs the latest npm package on an interval", () => {
    const plist = buildLaunchdPlist(
      syncCommandArgs("/usr/local/bin/npm"),
      "/home/u/.config/whoburnedmore/sync.log",
    );
    expect(plist).toContain("com.whoburnedmore.sync");
    expect(plist).toContain("/usr/local/bin/npm");
    expect(plist).toContain("<string>exec</string>");
    expect(plist).toContain("<string>--yes</string>");
    expect(plist).toContain("<string>--ignore-scripts</string>");
    expect(plist).toContain("<string>--package</string>");
    expect(plist).toContain("<string>whoburnedmore@latest</string>");
    expect(plist).toContain("<string>--</string>");
    expect(plist).toContain("<string>whoburnedmore</string>");
    expect(plist).toContain("<string>sync</string>");
    expect(plist).toContain("/home/u/.config/whoburnedmore/sync.log");
    expect(plist).not.toContain("/tmp/");
    expect(plist).toContain(`<integer>${SYNC_INTERVAL_MINUTES * 60}</integer>`);
  });

  it("syncs at a sub-hour (15min) cadence by default", () => {
    // The cadence drop from hourly → 15min: the plist must carry 900s, not 3600s.
    expect(SYNC_INTERVAL_MINUTES).toBe(15);
    expect(syncIntervalLabel(15)).toBe("15m");
    expect(syncIntervalLabel(60)).toBe("1h");
    expect(syncIntervalLabel(120)).toBe("2h");
    // Linux cron uses the minute field for a sub-hour interval.
    expect(cronSchedule(15)).toBe("*/15 * * * *");
    expect(cronSchedule(60)).toBe("0 */1 * * *");
  });

  it("runs at load so a sync catches up after a reboot/login", () => {
    const plist = buildLaunchdPlist(syncCommandArgs("/usr/local/bin/npm"));
    // RunAtLoad must be true (not false) so a machine that missed a scheduled
    // tick while off/asleep syncs immediately on next login.
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).not.toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toContain("<key>ProcessType</key>");
  });

  it("bakes a PATH that makes `node` discoverable under launchd's stripped env", () => {
    // launchd runs jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin — which excludes
    // Homebrew's /opt/homebrew/bin. npm's shebang is `#!/usr/bin/env node`, so
    // without node on PATH every tick dies with `env: node: No such file or
    // directory` (exit 127) and the account silently stops syncing. The plist
    // must export a PATH containing the npm/node directory.
    const plist = buildLaunchdPlist(
      syncCommandArgs("/opt/homebrew/bin/npm"),
      "/home/u/.config/whoburnedmore/sync.log",
    );
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toMatch(
      /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*<\/string>/,
    );
  });

  it("escapes launchd XML values", () => {
    const plist = buildLaunchdPlist(
      syncCommandArgs("/home/a&b/bin/npm"),
      "/home/a&b/.config/whoburnedmore/sync.log",
    );
    expect(plist).toContain("/home/a&amp;b/bin/npm");
    expect(plist).toContain("/home/a&amp;b/.config/whoburnedmore/sync.log");
    expect(plist).not.toContain("/home/a&b/bin/npm");
  });
});

describe("syncEnv (identity/endpoint env propagation)", () => {
  it("always exports PATH first", () => {
    const pairs = syncEnv({ npmPath: "/opt/homebrew/bin/npm", env: {} });
    expect(pairs[0][0]).toBe("PATH");
    expect(pairs[0][1].split(":")[0]).toBe("/opt/homebrew/bin");
  });

  it("forwards the user's config-dir/endpoint env so background == foreground", () => {
    // The silent-divergence bug: a user who sets WHOBURNEDMORE_CONFIG_DIR in
    // their shell claims dashboard X foreground, but the scheduler (clean env)
    // mints a NEW anonKey under the default dir → submits to a separate
    // unclaimed dashboard. The agent must carry these vars over.
    const pairs = syncEnv({
      npmPath: "/usr/local/bin/npm",
      env: {
        WHOBURNEDMORE_CONFIG_DIR: "/home/u/.wbm",
        WHOBURNEDMORE_API: "https://api.example.com",
        CLAUDE_CONFIG_DIR: "/home/u/.claude-alt",
      },
    });
    const map = Object.fromEntries(pairs);
    expect(map.WHOBURNEDMORE_CONFIG_DIR).toBe("/home/u/.wbm");
    expect(map.WHOBURNEDMORE_API).toBe("https://api.example.com");
    expect(map.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude-alt");
  });

  it("omits vars that are unset or empty (no spurious keys)", () => {
    const pairs = syncEnv({
      npmPath: "/usr/bin/npm",
      env: { WHOBURNEDMORE_CONFIG_DIR: "", WHOBURNEDMORE_API: undefined },
    });
    const keys = pairs.map(([k]) => k);
    expect(keys).toEqual(["PATH"]);
  });

  it("drops a forwarded value containing a newline (cron/systemd are line-oriented)", () => {
    const pairs = syncEnv({
      npmPath: "/usr/bin/npm",
      env: {
        WHOBURNEDMORE_API: "https://evil\nMALICIOUS=1",
        WHOBURNEDMORE_WEB: "https://ok.example",
      },
    });
    const map = Object.fromEntries(pairs);
    expect(map.WHOBURNEDMORE_API).toBeUndefined();
    expect(map.WHOBURNEDMORE_WEB).toBe("https://ok.example");
  });

  it("never forwards arbitrary/secret env (allowlist only)", () => {
    const pairs = syncEnv({
      npmPath: "/usr/bin/npm",
      env: { AWS_SECRET_ACCESS_KEY: "shh", HOME: "/home/u" },
    });
    expect(pairs.map(([k]) => k)).toEqual(["PATH"]);
  });

  it("propagates forwarded vars into the launchd plist and systemd unit", () => {
    const envPairs: Array<[string, string]> = [
      ["PATH", "/opt/homebrew/bin:/usr/bin:/bin"],
      ["WHOBURNEDMORE_CONFIG_DIR", "/home/u/.wbm"],
    ];
    const plist = buildLaunchdPlist(
      syncCommandArgs("/opt/homebrew/bin/npm"),
      "/home/u/.config/whoburnedmore/sync.log",
      envPairs,
    );
    expect(plist).toContain("<key>WHOBURNEDMORE_CONFIG_DIR</key>");
    expect(plist).toContain("<string>/home/u/.wbm</string>");
    const service = buildSystemdService(
      syncCommandArgs("/usr/bin/npm"),
      envPairs,
    );
    expect(service).toContain(
      'Environment="WHOBURNEDMORE_CONFIG_DIR=/home/u/.wbm"',
    );
  });

  it("escapes cron `%` and systemd `%` specifiers in values", () => {
    // A path/value with `%` must not become a cron newline nor a systemd specifier.
    expect(systemdQuote("PATH=/home/od%d/bin")).toBe('"PATH=/home/od%%d/bin"');
    const line = expectedLinuxCronLine({
      npmPath: "/usr/bin/npm",
      logPath: "/home/od%d/.config/whoburnedmore/sync.log",
    });
    expect(line).not.toMatch(/[^\\]%/); // every % is backslash-escaped for cron
    expect(line).toContain("\\%");
  });
});

describe("scheduled sync command", () => {
  it("uses npm exec with latest package and no lifecycle scripts", () => {
    expect(syncCommandArgs("/usr/local/bin/npm")).toEqual([
      "/usr/local/bin/npm",
      "exec",
      "--yes",
      "--ignore-scripts",
      "--package",
      "whoburnedmore@latest",
      "--",
      "whoburnedmore",
      "sync",
    ]);
  });

  it("derives a PATH that puts the npm/node directory ahead of system dirs", () => {
    const path = syncPathEnv("/opt/homebrew/bin/npm");
    expect(path.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(path).toContain("/usr/bin");
    expect(path).toContain("/bin");
    // No duplicate entry when the npm dir is already a standard dir.
    const dedup = syncPathEnv("/usr/bin/npm");
    expect(dedup.split(":").filter((d) => d === "/usr/bin")).toHaveLength(1);
  });

  it("covers the real install layouts that launchd/cron strip from PATH", () => {
    // Apple-Silicon Homebrew
    expect(syncPathEnv("/opt/homebrew/bin/npm").split(":")[0]).toBe(
      "/opt/homebrew/bin",
    );
    // Intel Homebrew / official .pkg installer (node lands in /usr/local/bin,
    // which launchd's default PATH also excludes).
    expect(syncPathEnv("/usr/local/bin/npm").split(":")[0]).toBe(
      "/usr/local/bin",
    );
    // nvm / fnm / volta / asdf: a version-pinned dir nowhere near the standard
    // ones — must still be prepended so `env node` resolves.
    const nvm = syncPathEnv("/Users/me/.nvm/versions/node/v22.3.0/bin/npm");
    expect(nvm.split(":")[0]).toBe("/Users/me/.nvm/versions/node/v22.3.0/bin");
    expect(nvm).toContain("/usr/bin");
  });

  it("does not prepend a bare/relative npm path to PATH", () => {
    // resolveNpmPath can fall back to a bare "npm"/"npm.cmd" with no directory;
    // dirname("npm") === "." must never leak into PATH.
    const path = syncPathEnv("npm");
    expect(path.split(":")).not.toContain(".");
    expect(path).toContain("/usr/bin");
  });

  it("includes a PATH= prefix in the cron line so node resolves under cron", () => {
    const line = expectedLinuxCronLine({ npmPath: "/usr/local/bin/npm" });
    expect(line).toContain("PATH=");
    expect(line).toContain("/usr/local/bin");
  });

  it("quotes linux cron command and log paths without shell injection", () => {
    const logPath =
      "/home/me/.config/whoburnedmore/sync log'$(touch hacked).log";
    const line = expectedLinuxCronLine({
      npmPath: "/home/me/bin/npm with space",
      logPath,
    });
    expect(line).toContain("*/15 * * * *");
    expect(line).toContain("'whoburnedmore@latest'");
    expect(line).toContain("'sync'");
    expect(line).toContain(shellQuote(logPath));
  });

  it("quotes windows scheduled-task commands", () => {
    const line = windowsCommandLine(
      syncCommandArgs("C:\\Program Files\\nodejs\\npm.cmd"),
    );
    expect(line).toContain('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(line).toContain('"whoburnedmore@latest"');
    expect(line).toContain('"sync"');
  });

  it("keeps escaping helpers deterministic", () => {
    expect(xmlEscape(`a&b<"c'>`)).toBe("a&amp;b&lt;&quot;c&apos;&gt;");
    expect(shellQuote(`a'b`)).toBe(`'a'\"'\"'b'`);
  });
});

describe("systemd user-timer fallback (linux without crontab)", () => {
  it("builds a oneshot service that runs the latest package on each tick", () => {
    const service = buildSystemdService(syncCommandArgs("/usr/local/bin/npm"));
    expect(service).toContain("[Service]");
    expect(service).toContain("Type=oneshot");
    expect(service).toContain('ExecStart="/usr/local/bin/npm"');
    expect(service).toContain('"whoburnedmore@latest"');
    expect(service).toContain('"sync"');
    // systemd parses ExecStart itself — must NOT carry shell single-quotes.
    expect(service).not.toContain("'whoburnedmore@latest'");
  });

  it("exports a PATH so npm's `env node` shebang resolves under systemd", () => {
    const service = buildSystemdService(syncCommandArgs("/usr/local/bin/npm"));
    expect(service).toContain('Environment="PATH=');
    expect(service).toContain("/usr/local/bin");
  });

  it("builds a timer on the 15min cadence that survives reboots", () => {
    const timer = buildSystemdTimer();
    expect(timer).toContain(`OnUnitActiveSec=${SYNC_INTERVAL_MINUTES}min`);
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("quotes systemd ExecStart args, escaping backslashes and quotes", () => {
    expect(systemdQuote("plain")).toBe('"plain"');
    expect(systemdQuote('a"b')).toBe('"a\\"b"');
    expect(systemdQuote("a\\b")).toBe('"a\\\\b"');
  });

  it("drift-detects a stale systemd interval the same way the plist path does", () => {
    // The reconcile machinery compares installed-vs-expected content; a timer
    // frozen at an old cadence must read as drift so heal-on-run rewrites it.
    const expected = `${buildSystemdService(syncCommandArgs("/usr/local/bin/npm"))}\n${buildSystemdTimer(15)}`;
    const stale = `${buildSystemdService(syncCommandArgs("/usr/local/bin/npm"))}\n${buildSystemdTimer(60)}`;
    expect(stale).not.toBe(expected);
    expect(plistDrift(stale, expected)).toBe("drift");
    expect(plistDrift(expected, expected)).toBe("ok");
    expect(reconcileAction(plistDrift(stale, expected))).toBe("install");
  });
});

describe("notifyLaunchLive", () => {
  it("uses macOS notification center to send the launch message", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ok = notifyLaunchLive({
      platform: "darwin",
      spawn: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(calls[0].cmd).toBe("osascript");
    expect(calls[0].args.join(" ")).toContain("whoburnedmore.com");
  });

  it("falls back cleanly when no desktop notifier is available", () => {
    const ok = notifyLaunchLive({
      platform: "linux",
      spawn: () => ({ status: 1 }),
    });
    expect(ok).toBe(false);
  });

  it("uses built-in PowerShell APIs on Windows", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ok = notifyLaunchLive({
      platform: "win32",
      spawn: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0 };
      },
    });

    expect(ok).toBe(true);
    expect(calls[0].cmd).toBe("powershell");
    expect(calls[0].args.join(" ")).toContain("System.Windows.Forms");
    expect(calls[0].args.join(" ")).not.toContain("BurntToast");
  });
});

describe("resolveNodePath (stable node path)", () => {
  it("prefers a stable symlink over a version-pinned Cellar execPath", () => {
    const got = resolveNodePath({
      candidates: ["/opt/homebrew/bin/node"],
      check: (p) => p === "/opt/homebrew/bin/node",
      execPath: "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
    });
    expect(got).toBe("/opt/homebrew/bin/node");
    // The whole point: never bake the path that dies on `brew upgrade node`.
    expect(got).not.toContain("/Cellar/");
  });

  it("falls back to process execPath when no stable candidate qualifies", () => {
    const got = resolveNodePath({
      candidates: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
      check: () => false,
      execPath: "/some/runtime/node",
    });
    expect(got).toBe("/some/runtime/node");
  });
});

describe("resolveNpmPath (stable npm path)", () => {
  it("prefers a stable npm symlink", () => {
    const got = resolveNpmPath({
      candidates: ["/opt/homebrew/bin/npm"],
      check: (p) => p === "/opt/homebrew/bin/npm",
      execPath: "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
    });
    expect(got).toBe("/opt/homebrew/bin/npm");
    expect(got).not.toContain("/Cellar/");
  });

  it("falls back to npm next to the current node executable", () => {
    const got = resolveNpmPath({
      candidates: ["/missing/npm"],
      check: (p) => p === "/some/runtime/npm",
      execPath: "/some/runtime/node",
      platform: "linux",
    });
    expect(got).toBe(posix.join("/some/runtime", "npm"));
  });

  it("uses npm.cmd next to node.exe on Windows", () => {
    const got = resolveNpmPath({
      candidates: [],
      check: (p) => p.endsWith("\\npm.cmd"),
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    expect(got).toBe("C:\\Program Files\\nodejs\\npm.cmd");
  });
});

describe("plistDrift + reconcileAction (content drift reconciliation)", () => {
  const expected = buildLaunchdPlist(syncCommandArgs("/usr/local/bin/npm"));

  it("reports absent (→ install) when nothing is installed", () => {
    expect(plistDrift(null, expected)).toBe("absent");
    expect(reconcileAction("absent")).toBe("install");
  });

  it("reports drift (→ reinstall) for a stale hourly StartInterval vs a 15min source", () => {
    // The exact bug we are hardening against: an installed plist frozen at the old
    // 3600s (1h) cadence while the current source emits 900s (15min).
    const stale = expected.replace(
      "<integer>900</integer>",
      "<integer>3600</integer>",
    );
    expect(stale).not.toBe(expected);
    expect(plistDrift(stale, expected)).toBe("drift");
    expect(reconcileAction("drift")).toBe("install");
  });

  it("reports drift for a dead version-pinned Cellar node path", () => {
    const stale = expected.replace(
      "/usr/local/bin/npm",
      "/opt/homebrew/Cellar/node/25.9.0_2/bin/npm",
    );
    expect(plistDrift(stale, expected)).toBe("drift");
  });

  it("reports ok (→ noop) when the installed agent already matches", () => {
    expect(plistDrift(expected, expected)).toBe("ok");
    expect(reconcileAction("ok")).toBe("noop");
  });

  it("reports drift for the old PATH-less plist so broken machines self-heal", () => {
    // The exact regression (CLI 0.8.9–0.9.2): a plist that runs `npm exec` but
    // carries no EnvironmentVariables/PATH block. Stripping that block must read
    // as drift so the next foreground `reconcileAutoSync()` rewrites it with PATH.
    const broken = expected.replace(
      /  <key>EnvironmentVariables<\/key>\n  <dict>\n.*?\n  <\/dict>\n/s,
      "",
    );
    expect(broken).not.toContain("EnvironmentVariables");
    expect(broken).not.toBe(expected);
    expect(plistDrift(broken, expected)).toBe("drift");
    expect(reconcileAction("drift")).toBe("install");
  });
});

describe("rotateLogIfLarge (log rotation)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wbm-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rolls the log to .1 once it exceeds the cap", () => {
    const log = join(dir, "sync.log");
    const big = "x".repeat(2048);
    writeFileSync(log, big);
    const rotated = rotateLogIfLarge(log, 1024);
    expect(rotated).toBe(true);
    expect(existsSync(log)).toBe(false); // fresh log starts on next write
    expect(readFileSync(`${log}.1`, "utf8")).toBe(big);
  });

  it("leaves a small log untouched", () => {
    const log = join(dir, "sync.log");
    writeFileSync(log, "tiny");
    expect(rotateLogIfLarge(log, 1024)).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("tiny");
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("is a no-op (no throw) when the log does not exist", () => {
    expect(rotateLogIfLarge(join(dir, "nope.log"), 1024)).toBe(false);
  });
});
