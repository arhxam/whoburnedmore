import { describe, expect, it } from "vitest";
import { argumentProblem, confirmAnswer, parseBoard, resolveCommand } from "../src/args.js";

const check = (...args: string[]) => argumentProblem(args, resolveCommand(args));

describe("argv that must never become a public upload", () => {
  it("still resolves help when a value flag is missing its value", () => {
    expect(resolveCommand(["--board", "--help"])).toBe("help");
    expect(resolveCommand(["--org", "-h"])).toBe("help");
    // ...while a real value is still skipped, so `--board help` is a board code.
    expect(resolveCommand(["--board", "help"])).toBe("run");
    expect(parseBoard(["--board", "help"])).toBe("help");
  });

  it("rejects unknown flags instead of ignoring them", () => {
    expect(check("--dryrun")).toMatch(/Unknown option --dryrun/);
    expect(check("--offline")).toMatch(/Unknown option --offline/);
    expect(check("--breakdown=daily")).toMatch(/Unknown option --breakdown/);
  });

  it("rejects on/off flags written with a value", () => {
    expect(check("--dry-run=true")).toMatch(/--dry-run doesn't take a value/);
    expect(check("--local=1")).toMatch(/--local doesn't take a value/);
    expect(check("--watch=1")).toMatch(/--watch doesn't take a value/);
  });

  it("rejects no-upload flags on commands that would ignore them", () => {
    expect(check("link", "--dry-run")).toMatch(/only works with the default command/);
    expect(check("verify", "--dry-run")).toMatch(/only works with the default command/);
    expect(check("install-sync", "--local")).toMatch(/only works with the default command/);
    expect(check("public", "--local")).toMatch(/only works with the default command/);
  });

  it("rejects a value flag with no value", () => {
    expect(check("--board")).toMatch(/--board needs a value/);
    expect(check("--org=")).toMatch(/--org needs a value/);
    expect(check("--board", "--dry-run")).toMatch(/--board needs a value/);
  });

  it("rejects --watch and sync combined with a no-upload flag", () => {
    expect(check("--dry-run", "--watch")).toMatch(/--watch keeps uploading/);
    expect(check("--local", "--watch")).toMatch(/--watch keeps uploading/);
    expect(check("sync", "--no-submit")).toMatch(/sync always uploads/);
    expect(check("daemon", "--dry-run")).toMatch(/daemon always uploads/);
    expect(check("status", "--watch")).toMatch(/--watch only works/);
  });

  it("accepts every documented invocation", () => {
    for (const argv of [
      [],
      ["--local"],
      ["--dry-run"],
      ["--no-submit"],
      ["--board=AB12"],
      ["--board", "AB12"],
      ["--org=acme", "--pass=secret"],
      ["--org", "acme", "--code", "secret"],
      ["sync"],
      ["sync", "--watch"],
      ["--watch"],
      ["daemon"],
      ["link"],
      ["status"],
      ["private"],
      ["public"],
      ["remove"],
      ["verify"],
      ["install-sync"],
      ["uninstall-sync"],
      ["--help"],
      ["--version"],
      ["--helpp", "--help"],
    ]) {
      expect(check(...argv), argv.join(" ")).toBeNull();
    }
  });
});

describe("confirmAnswer", () => {
  it("treats Enter as the prompt's default", () => {
    expect(confirmAnswer("", false)).toBe(false);
    expect(confirmAnswer("  ", false)).toBe(false);
    expect(confirmAnswer("", true)).toBe(true);
  });
  it("only accepts an explicit yes", () => {
    expect(confirmAnswer("y", false)).toBe(true);
    expect(confirmAnswer("YES", false)).toBe(true);
    expect(confirmAnswer("n", true)).toBe(false);
    expect(confirmAnswer("sure", true)).toBe(false);
  });
});
