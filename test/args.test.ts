import { describe, expect, it } from "vitest";
import {
  applyScope,
  parseBoard,
  parseInstallToken,
  parseOrg,
  parsePass,
  resolveCommand,
} from "../src/args.js";

describe("parseBoard", () => {
  it("reads --board=<code>", () => {
    expect(parseBoard(["--board=abc123"])).toBe("abc123");
  });

  it("reads --board <code> (space form)", () => {
    expect(parseBoard(["--board", "deadbeef"])).toBe("deadbeef");
  });

  it("is undefined when absent", () => {
    expect(parseBoard(["--dry-run"])).toBeUndefined();
    expect(parseBoard([])).toBeUndefined();
  });

  it("ignores an empty value and a following flag", () => {
    expect(parseBoard(["--board="])).toBeUndefined();
    expect(parseBoard(["--board", "--local"])).toBeUndefined();
  });

  it("coexists with other flags in any order", () => {
    expect(parseBoard(["--dry-run", "--board=lab7", "--no-submit"])).toBe("lab7");
  });
});

describe("parseOrg", () => {
  it("reads --org=<slug>", () => {
    expect(parseOrg(["--org=hackclub"])).toBe("hackclub");
  });
  it("reads --org <slug> (space form)", () => {
    expect(parseOrg(["--org", "hackclub"])).toBe("hackclub");
  });
  it("is undefined when absent", () => {
    expect(parseOrg([])).toBeUndefined();
    expect(parseOrg(["--dry-run"])).toBeUndefined();
  });
  it("ignores an empty value and a following flag", () => {
    expect(parseOrg(["--org="])).toBeUndefined();
    expect(parseOrg(["--org", "--local"])).toBeUndefined();
  });
});

describe("parsePass", () => {
  it("reads --pass=<code>", () => {
    expect(parsePass(["--org=acme", "--pass=hunter2"])).toBe("hunter2");
  });
  it("reads --pass <code> (space form)", () => {
    expect(parsePass(["--org", "acme", "--pass", "hunter2"])).toBe("hunter2");
  });
  it("accepts the --code alias", () => {
    expect(parsePass(["--code=novelty1"])).toBe("novelty1");
    expect(parsePass(["--code", "novelty1"])).toBe("novelty1");
  });
  it("is undefined when absent / empty", () => {
    expect(parsePass([])).toBeUndefined();
    expect(parsePass(["--pass="])).toBeUndefined();
    expect(parsePass(["--pass", "--org=acme"])).toBeUndefined();
  });
});

describe("payload scope carries the org password (applyScope)", () => {
  it("attaches orgCode only alongside org", () => {
    const p = applyScope({ cliVersion: "x", entries: [] as unknown[] }, {
      org: "acme",
      orgCode: "secret",
    }) as Record<string, unknown>;
    expect(p.org).toBe("acme");
    expect(p.orgCode).toBe("secret");
  });
  it("drops orgCode when there is no org (a password without a target is meaningless)", () => {
    const p = applyScope({ cliVersion: "x", entries: [] as unknown[] }, {
      orgCode: "secret",
    }) as Record<string, unknown>;
    expect("orgCode" in p).toBe(false);
  });
});

describe("parseInstallToken", () => {
  it("reads --token=<value>", () => {
    expect(parseInstallToken(["link", "--token=abc.def"])).toBe("abc.def");
  });

  it("reads --token <value> (space form)", () => {
    expect(parseInstallToken(["link", "--token", "abc.def"])).toBe("abc.def");
  });

  it("ignores an empty value and a following flag", () => {
    expect(parseInstallToken(["link", "--token="])).toBeUndefined();
    expect(parseInstallToken(["link", "--token", "--dry-run"])).toBeUndefined();
  });
});

describe("payload scope (applyScope)", () => {
  it("payload omits org when flag absent", () => {
    const p = applyScope({ cliVersion: "x", entries: [] as unknown[] }, {});
    expect("org" in p).toBe(false);
    expect("board" in p).toBe(false);
  });
  it("attaches org and board only when present", () => {
    const p = applyScope({ cliVersion: "x", entries: [] as unknown[] }, {
      org: "hackclub",
      board: "abc123",
    }) as Record<string, unknown>;
    expect(p.org).toBe("hackclub");
    expect(p.board).toBe("abc123");
  });
});

describe("resolveCommand", () => {
  it("defaults to run with no args", () => {
    expect(resolveCommand([])).toBe("run");
  });

  it("treats lone non-command flags as a run (with those flags applied elsewhere)", () => {
    expect(resolveCommand(["--dry-run"])).toBe("run");
    expect(resolveCommand(["--local"])).toBe("run");
    expect(resolveCommand(["--board=abc"])).toBe("run");
    expect(resolveCommand(["--org=hackclub"])).toBe("run");
  });

  it("does not mistake a value-flag's value for a command (space form)", () => {
    expect(resolveCommand(["--org", "hackclub"])).toBe("run");
    expect(resolveCommand(["--board", "abc123"])).toBe("run");
  });

  it("does not mistake a value-flag's value of 'help'/'version' for that command", () => {
    // Regression: a board/org literally named "help" or "version" used to trip
    // the blanket args.includes() scan and show help/version instead of running.
    expect(resolveCommand(["--board", "help"])).toBe("run");
    expect(resolveCommand(["--org", "version"])).toBe("run");
    expect(resolveCommand(["--token", "help"])).toBe("run");
    // A real explicit subcommand still wins over a value named "help".
    expect(resolveCommand(["sync", "--board", "help"])).toBe("sync");
  });

  it("maps --help and -h to help — never a silent run/submit", () => {
    // Regression: --help/-h start with '-', so the old first-non-dash-arg
    // resolution fell through to "run" and PUBLICLY SUBMITTED the user's usage.
    expect(resolveCommand(["--help"])).toBe("help");
    expect(resolveCommand(["-h"])).toBe("help");
    expect(resolveCommand(["help"])).toBe("help");
  });

  it("maps --version and -v to version", () => {
    expect(resolveCommand(["--version"])).toBe("version");
    expect(resolveCommand(["-v"])).toBe("version");
    expect(resolveCommand(["version"])).toBe("version");
  });

  it("help wins even alongside other flags or subcommands", () => {
    expect(resolveCommand(["private", "--help"])).toBe("help");
    expect(resolveCommand(["--dry-run", "-h"])).toBe("help");
  });

  it("returns an explicit subcommand verbatim (so unknowns still error in main)", () => {
    expect(resolveCommand(["private"])).toBe("private");
    expect(resolveCommand(["sync"])).toBe("sync");
    expect(resolveCommand(["link", "--token=abc.def"])).toBe("link");
    expect(resolveCommand(["remove"])).toBe("remove");
    expect(resolveCommand(["bogus"])).toBe("bogus");
  });
});
