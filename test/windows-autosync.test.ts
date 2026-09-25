import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWindowsLauncher, buildWindowsTaskXml, decodeTaskXml, installWindowsSync, readWindowsTask,
  resolveWindowsNpmCli, uninstallWindowsSync, windowsLauncherPath, windowsTaskDrift,
  windowsTaskEnabled, type WindowsSyncOptions,
} from "../src/windows-autosync.js";
import { syncCommandArgs } from "../src/autosync.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));

const opts: WindowsSyncOptions = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  npmCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  configDir: "C:\\Users\\Dell\\.config\\whoburnedmore",
  commandArgs: syncCommandArgs("npm").slice(1),
  envPairs: [["WHOBURNEDMORE_CONFIG_DIR", "C:\\Users\\Dell\\.config\\whoburnedmore"]],
  intervalMinutes: 15,
  systemRoot: "C:\\Windows",
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wbm-windows-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function launcherCommand(options = opts, exitCode = 0): string {
  let command = "";
  runInNewContext(buildWindowsLauncher(options), {
    ActiveXObject: function (name: string) {
      expect(name).toBe("WScript.Shell");
      return { Run: (cmd: string, style: number, wait: boolean) => {
        command = cmd;
        expect(style).toBe(0);
        expect(wait).toBe(true);
        return exitCode;
      } };
    },
    WScript: { Quit: (code: number) => expect(code).toBe(exitCode) },
  });
  return command;
}

function launcherScript(options = opts): string {
  const command = launcherCommand(options);
  const encoded = command.split(" -EncodedCommand ")[1];
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("Windows windowless launcher", () => {
  it.each([0, 1, 23])("waits for the hidden child and propagates exit %s", (code) => {
    expect(launcherCommand(opts, code)).toContain("-NoProfile -NonInteractive -EncodedCommand");
  });

  it("runs npm through node, preserves version pin and disables lifecycle scripts", () => {
    const script = launcherScript();
    expect(script).toContain(`& '${opts.nodePath}' '${opts.npmCliPath}' 'exec' '--yes' '--ignore-scripts'`);
    expect(script).toContain(`'${opts.commandArgs[4]}' '--' 'whoburnedmore' 'sync'`);
    expect(script).not.toContain("npm.cmd");
    expect(script).toContain("$env:Path = 'C:\\Program Files\\nodejs;' + $env:Path");
    expect(script).toContain("$env:WHOBURNEDMORE_CONFIG_DIR =");
    expect(script).toContain("Set-Location -LiteralPath");
    expect(script).toContain("2>&1 | Out-File -LiteralPath $log -Append -Encoding utf8");
    expect(script).toContain("sync exited");
    expect(script).toContain("-gt 262144");
    expect(script).toContain("$code = $LASTEXITCODE");
    expect(script).toContain("exit $code");
  });

  it("keeps Unicode, quotes, percent expansion and shell metacharacters inside the encoded payload", () => {
    const path = "C:\\Users\\O'Brien & %TEMP% $() ` 東京\\.config\\whoburnedmore";
    const options = { ...opts, configDir: path, envPairs: [["WHOBURNEDMORE_CONFIG_DIR", path]] as Array<[string, string]> };
    const command = launcherCommand(options);
    expect(command).not.toContain("%TEMP%");
    expect(command).not.toContain("O'Brien");
    expect(launcherScript(options)).toContain(path.replaceAll("'", "''"));
  });
});

describe("Windows npm resolution", () => {
  it("uses npm-cli.js next to node without trying to execute npm.cmd", () => {
    const exists = vi.fn(() => true);
    expect(resolveWindowsNpmCli({ nodePath: opts.nodePath, env: {}, exists })).toBe(opts.npmCliPath);
    expect(exists).toHaveBeenCalledTimes(1);
  });
  it("supports version managers through npm_execpath", () => {
    const cli = "D:\\tools\\npm\\bin\\npm-cli.js";
    expect(resolveWindowsNpmCli({ nodePath: opts.nodePath, env: { npm_execpath: cli }, exists: (p) => p === cli })).toBe(cli);
  });
  it("fails with a repair instruction rather than scheduling a bare/batch executable", () => {
    expect(() => resolveWindowsNpmCli({ nodePath: opts.nodePath, env: { npm_execpath: "npm.cmd" }, exists: () => false })).toThrow("repair your Node/npm installation");
  });
});

describe("Windows task reconciliation", () => {
  const launcher = buildWindowsLauncher(opts);
  const xml = buildWindowsTaskXml(opts);
  it("uses an interactive limited user and GUI host with a 15-minute non-overlapping trigger", () => {
    expect(xml).toContain("wscript.exe</Command>");
    expect(xml).toContain("//B //Nologo //E:JScript");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<Interval>PT15M</Interval>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).not.toContain("<Duration>");
    expect(xml).not.toContain("<EndBoundary>");
    expect(xml).not.toContain("S4U");
  });
  it("ignores scheduler timestamps, registration metadata and escaped XML", () => {
    const other = { ...opts, configDir: "C:\\Users\\O'Brien & Co\\.wbm" };
    const expected = buildWindowsTaskXml(other, new Date("2026-01-01T00:00:00Z"));
    expect(windowsTaskDrift(expected.replace('<Principal id="Author">', '<Principal id="Author"><UserId>S-1-5-21-123</UserId>'), buildWindowsLauncher(other), other)).toBe("ok");
    expect(windowsTaskDrift(xml, launcher, opts)).toBe("ok");
    const withDefaults = xml.replace("<Settings>", "<Settings><IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>");
    expect(windowsTaskDrift(withDefaults, launcher, opts)).toBe("ok");
  });
  it("repairs legacy npm.cmd actions, missing files and stale versions/env", () => {
    expect(windowsTaskDrift(null, null, opts)).toBe("absent");
    expect(windowsTaskDrift(xml, null, opts)).toBe("drift");
    expect(windowsTaskDrift(xml, launcher, { ...opts, commandArgs: ["exec", "--package", "whoburnedmore@0.0.1"] })).toBe("drift");
    expect(windowsTaskDrift(xml, launcher, { ...opts, envPairs: [["WHOBURNEDMORE_API", "https://example.com"]] })).toBe("drift");
    expect(windowsTaskDrift(xml.replace(/<Command>.*<\/Command>/, "<Command>npm.cmd</Command>"), launcher, opts)).toBe("drift");
  });
  it.each([
    ["PT15M", "PT4H"], ["InteractiveToken", "S4U"], ["LeastPrivilege", "HighestAvailable"],
    ["IgnoreNew", "Parallel"], ["PT14M", "PT72H"],
    ["</TimeTrigger>", "<EndBoundary>2026-01-01T00:00:00Z</EndBoundary></TimeTrigger>"],
    ["</Repetition>", "<Duration>P1D</Duration></Repetition>"],
    ["<Enabled>true</Enabled>", "<Enabled>false</Enabled>"],
  ])("detects drift from %s to %s", (from, to) => {
    expect(windowsTaskDrift(xml.replace(from, to), launcher, opts)).toBe("drift");
  });
  it("does not re-enable an explicitly disabled task", () => {
    const disabled = xml.replace("<StartWhenAvailable>true</StartWhenAvailable><Enabled>true", "<StartWhenAvailable>true</StartWhenAvailable><Enabled>false");
    expect(windowsTaskEnabled(disabled)).toBe(false);
    expect(windowsTaskDrift(disabled, null, opts)).toBe("ok");
  });
});

describe("Windows scheduler error handling", () => {
  it.each(["utf8", "utf16le"] as const)("decodes redirected %s XML with Unicode paths", (encoding) => {
    const xml = buildWindowsTaskXml({ ...opts, configDir: "C:\\Users\\東京" });
    expect(decodeTaskXml(Buffer.from("\uFEFF" + xml, encoding))).toBe(xml);
    expect(decodeTaskXml(Buffer.from(xml, encoding))).toBe(xml);
  });
  it("does not misreport scheduler failure as an absent task", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stderr: "Access is denied" } as never);
    expect(() => readWindowsTask()).toThrow("Access is denied");
  });
  it("recognizes an absent task when the scheduler is reachable", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as never).mockReturnValueOnce({ status: 0 } as never);
    expect(readWindowsTask()).toBeNull();
  });
  it("keeps the launcher when task deletion fails", () => {
    const configDir = tempDir();
    const file = join(configDir, "sync-launcher.js");
    writeFileSync(file, "existing launcher");
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: buildWindowsTaskXml(opts) } as never)
      .mockReturnValueOnce({ status: 1, stderr: "Access is denied" } as never);
    expect(() => uninstallWindowsSync(configDir)).toThrow("Access is denied");
    expect(readFileSync(file, "utf8")).toBe("existing launcher");
  });
});

// Runs in Windows CI: actual WSH -> PowerShell -> node process chain and an
// isolated scheduler fixture. No production config, network calls or uploads.
describe.skipIf(process.platform !== "win32")("native Windows launcher", () => {
  it.each([0, 1, 23])("logs stdout/stderr and preserves exit %s", async (code) => {
    const { spawnSync: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const configDir = mkdtempSync(join(tempDir(), "O'Brien & %TEMP% 東京-"));
    const npmCliPath = join(configDir, "fake-npm.cjs");
    writeFileSync(npmCliPath, `console.log('stdout marker'); console.error('stderr marker'); console.log(process.env.WHOBURNEDMORE_CONFIG_DIR); process.exitCode = ${code};`);
    const options = { ...opts, configDir, nodePath: process.execPath, npmCliPath,
      systemRoot: process.env.SystemRoot!, envPairs: [["WHOBURNEDMORE_CONFIG_DIR", "O'Brien & %TEMP% 東京"]] as Array<[string, string]> };
    writeFileSync(windowsLauncherPath(options), buildWindowsLauncher(options));
    const result = realSpawn("wscript.exe", ["//B", "//Nologo", "//E:JScript", windowsLauncherPath(options)], { windowsHide: true, timeout: 30_000 });
    expect(result.status).toBe(code);
    const log = readFileSync(join(configDir, "sync.log"), "utf8");
    expect(log).toContain("stdout marker");
    expect(log).toContain("stderr marker");
    expect(log).toContain(`sync exited ${code}`);
    expect(log).toContain("O'Brien & %TEMP% 東京");
  }, 35_000);
  it("handles repeated noisy ticks, rotates logs, and preserves argv/cwd/env", async () => {
    const { spawnSync: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const configDir = mkdtempSync(join(tempDir(), "O'Brien & %TEMP% 東京-"));
    const npmCliPath = join(configDir, "fake-npm.cjs");
    const options = { ...opts, configDir, nodePath: process.execPath, npmCliPath,
      systemRoot: process.env.SystemRoot!, envPairs: [["WHOBURNEDMORE_CONFIG_DIR", configDir]] as Array<[string, string]> };
    writeFileSync(windowsLauncherPath(options), buildWindowsLauncher(options));
    for (let tick = 0; tick < 4; tick++) {
      writeFileSync(npmCliPath, `
        const assert = require('node:assert/strict');
        assert.deepEqual(process.argv.slice(2), ${JSON.stringify(opts.commandArgs)});
        assert.equal(process.cwd(), ${JSON.stringify(configDir)});
        assert.equal(process.env.WHOBURNEDMORE_CONFIG_DIR, process.cwd());
        console.log('tick-${tick}');
        for (let line = 0; line < 80; line++) console.log('x'.repeat(4096));
        console.error('stderr-${tick}');
      `);
      const result = realSpawn("wscript.exe", ["//B", "//Nologo", "//E:JScript", windowsLauncherPath(options)], { windowsHide: true, timeout: 30_000 });
      const log = readFileSync(join(configDir, "sync.log"), "utf8");
      expect(result.status, log.slice(0, 6000)).toBe(0);
      expect(log).toContain(`tick-${tick}`);
      expect(log).toContain(`stderr-${tick}`);
      expect(log).toContain("sync exited 0");
      if (tick > 0) {
        expect(log).not.toContain(`tick-${tick - 1}`);
        expect(readFileSync(join(configDir, "sync.log.1"), "utf8")).toContain(`tick-${tick - 1}`);
      }
    }
  }, 90_000);
  it("records a missing runtime as failure instead of silently reporting success", async () => {
    const { spawnSync: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const configDir = tempDir();
    const options = { ...opts, configDir, nodePath: join(configDir, "missing-node.exe"), systemRoot: process.env.SystemRoot! };
    writeFileSync(windowsLauncherPath(options), buildWindowsLauncher(options));
    const result = realSpawn("wscript.exe", ["//B", "//Nologo", "//E:JScript", windowsLauncherPath(options)], { windowsHide: true, timeout: 30_000 });
    expect(result.status).toBe(1);
    const log = readFileSync(join(configDir, "sync.log"), "utf8");
    expect(log).toContain("missing-node.exe");
    expect(log).not.toContain("sync exited 0");
  }, 35_000);
  it("rolls back the launcher and surfaces task registration failures", () => {
    const configDir = tempDir();
    const options = { ...opts, configDir, systemRoot: process.env.SystemRoot! };
    const file = windowsLauncherPath(options);
    writeFileSync(file, "previous launcher");
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stderr: "Access is denied" } as never);
    expect(() => installWindowsSync(options)).toThrow("Access is denied");
    expect(readFileSync(file, "utf8")).toBe("previous launcher");
    rmSync(file);
    expect(() => installWindowsSync(options)).toThrow("Access is denied");
    expect(existsSync(file)).toBe(false);
  });
  it.skipIf(!process.env.CI)("round-trips the task definition through the real Windows scheduler", async () => {
    const { spawnSync: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const configDir = tempDir();
    const options = { ...opts, configDir, systemRoot: process.env.SystemRoot! };
    const name = `whoburnedmore-test-${process.pid}-${Date.now()}`;
    const xmlPath = join(configDir, "task.xml");
    // Register a future, uniquely named fixture; never run the production sync.
    writeFileSync(xmlPath, "\uFEFF" + buildWindowsTaskXml(options, new Date(Date.now() + 86400_000)), "utf16le");
    try {
      const created = realSpawn("schtasks.exe", ["/Create", "/TN", name, "/XML", xmlPath], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      expect(created.status, created.stderr || created.stdout).toBe(0);
      const queried = realSpawn("schtasks.exe", ["/Query", "/TN", name, "/XML"], { windowsHide: true, timeout: 15_000 });
      expect(queried.status).toBe(0);
      const installed = decodeTaskXml(queried.stdout);
      expect(windowsTaskDrift(installed, buildWindowsLauncher(options), options), installed).toBe("ok");
    } finally {
      const removed = realSpawn("schtasks.exe", ["/Delete", "/F", "/TN", name], { windowsHide: true, timeout: 15_000 });
      expect(removed.status).toBe(0);
    }
  }, 35_000);
});
