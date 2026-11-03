import { describe, expect, it } from "vitest";
import {
  acceptedConfirm,
  envDisablesDashboardOpen,
  FIRST_RUN_PRIVACY_LINES,
  runIntroLines,
  shouldOpenDashboard,
  signedInNextStepLines,
  statusSignedInLine,
  suppressionSignature,
  whoamiLine,
} from "../src/output.js";

describe("signedInNextStepLines", () => {
  it("is one line: @handle · rank #N · url", () => {
    const lines = signedInNextStepLines({
      handle: "cooldev",
      rank: 4,
      profileUrl: "https://whoburnedmore.com/u/cooldev",
    });
    expect(lines).toEqual([
      "  @cooldev · rank #4 · https://whoburnedmore.com/u/cooldev",
    ]);
    expect(lines.join("\n").toLowerCase()).not.toContain("sign in");
    expect(lines.join("\n").toLowerCase()).not.toContain("tokens");
  });

  it("omits rank when the server did not send one", () => {
    const line = signedInNextStepLines({
      handle: "cooldev",
      rank: null,
      profileUrl: "https://whoburnedmore.com/u/cooldev",
    })[0];
    expect(line).toBe("  @cooldev · https://whoburnedmore.com/u/cooldev");
    expect(line).not.toContain("rank");
  });

  it("prefers the org board, then the friends board, over the profile", () => {
    const org = signedInNextStepLines({
      handle: "ada",
      rank: 2,
      profileUrl: "https://whoburnedmore.com/u/x",
      boardUrl: "https://whoburnedmore.com/boards/ABC",
      orgBoardUrl: "https://whoburnedmore.com/o/acme/board",
    })[0];
    expect(org).toContain("/o/acme/board");
    expect(org).not.toContain("/u/x");
    expect(org).not.toContain("/boards/ABC");

    const board = signedInNextStepLines({
      handle: "ada",
      rank: 2,
      profileUrl: "https://whoburnedmore.com/u/x",
      boardUrl: "https://whoburnedmore.com/boards/ABC",
    })[0];
    expect(board).toContain("/boards/ABC");
    expect(board).not.toContain("npx whoburnedmore --board=");
  });

  it("strips terminal control bytes from the handle and url", () => {
    const line = signedInNextStepLines({
      handle: "a\u001b[31mx",
      rank: 1,
      profileUrl: "https://whoburnedmore.com/u/\u0007x",
    })[0];
    // eslint-disable-next-line no-control-regex -- asserting control bytes are gone
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("returning-user copy and dashboard open", () => {
  it("shows the two privacy lines only before the first sign-in", () => {
    const first = runIntroLines({ signedIn: false });
    expect(first.dim).toBe(true);
    expect(first.lines).toEqual([...FIRST_RUN_PRIVACY_LINES]);
    expect(first.lines).toHaveLength(2);

    const back = runIntroLines({ signedIn: true, handle: "ada" });
    expect(back).toEqual({ lines: ["  Signed in as @ada"], dim: false });
  });

  it("opens the dashboard only for a fresh sign-in or --open, and never off a TTY", () => {
    const base = {
      stdoutIsTTY: true,
      noOpen: false,
      signedInThisRun: false,
      open: false,
    };
    expect(shouldOpenDashboard(base)).toBe(false);
    expect(shouldOpenDashboard({ ...base, signedInThisRun: true })).toBe(true);
    expect(shouldOpenDashboard({ ...base, open: true })).toBe(true);
    expect(shouldOpenDashboard({ ...base, signedInThisRun: true, noOpen: true })).toBe(false);
    expect(shouldOpenDashboard({ ...base, open: true, stdoutIsTTY: false })).toBe(false);
    expect(envDisablesDashboardOpen("1")).toBe(true);
    expect(envDisablesDashboardOpen("0")).toBe(false);
    expect(envDisablesDashboardOpen(undefined)).toBe(false);
  });

  it("treats an empty Verify now? answer as No", () => {
    expect(acceptedConfirm("", false)).toBe(false);
    expect(acceptedConfirm("n", false)).toBe(false);
    expect(acceptedConfirm("y", false)).toBe(true);
    expect(acceptedConfirm("yes", false)).toBe(true);
    expect(acceptedConfirm("", true)).toBe(true);
  });

  it("asks Verify now? once per suppression event", () => {
    expect(suppressionSignature({ suppressed: false })).toBeNull();
    expect(suppressionSignature({ suppressed: true })).toBe("suppressed:");
    const first = suppressionSignature({
      suppressed: true,
      quarantinedDates: ["2026-06-02", "2026-06-01"],
    });
    const same = suppressionSignature({
      suppressed: true,
      quarantinedDates: ["2026-06-01", "2026-06-02"],
    });
    const next = suppressionSignature({
      suppressed: true,
      quarantinedDates: ["2026-06-03"],
    });
    expect(first).toBe(same);
    expect(next).not.toBe(first);
  });

  it("formats whoami and the status sign-in line", () => {
    expect(whoamiLine("ada", true)).toBe("  Signed in as @ada");
    expect(whoamiLine(undefined, false)).toContain("Not signed in");
    expect(statusSignedInLine("ada")).toBe("  • Signed in as @ada");
    expect(statusSignedInLine(null)).toBe("  • Signed in as: not signed in");
  });
});
