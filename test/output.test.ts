import { describe, it, expect } from "vitest";
import { signedInNextStepLines } from "../src/output.js";

describe("signedInNextStepLines (signed-in run — already on the board)", () => {
  it("points to the profile with no 'sign in + add X' funnel", () => {
    const text = signedInNextStepLines({
      profileUrl: "https://whoburnedmore.com/u/cooldev",
    }).join("\n");
    expect(text).toContain("https://whoburnedmore.com/u/cooldev");
    // The user is already signed in, so the sign-in/X funnel must be gone.
    expect(text.toLowerCase()).not.toContain("sign in");
    // No burn numbers leak into the terminal here either.
    expect(text.toLowerCase()).not.toContain("tokens");
    expect(text).not.toMatch(/\$\s*\d/);
  });

  it("prefers the org board, then the friends board, over the profile", () => {
    const org = signedInNextStepLines({
      profileUrl: "https://whoburnedmore.com/u/x",
      boardUrl: "https://whoburnedmore.com/boards/ABC",
      orgBoardUrl: "https://whoburnedmore.com/o/acme/board",
    }).join("\n");
    expect(org).toContain("/o/acme/board");
    expect(org).not.toContain("/u/x");

    const board = signedInNextStepLines({
      profileUrl: "https://whoburnedmore.com/u/x",
      boardUrl: "https://whoburnedmore.com/boards/ABC",
    }).join("\n");
    expect(board).toContain("/boards/ABC");
    expect(board).toContain("npx whoburnedmore --board=ABC");
  });
});

describe("signedInNextStepLines for a member who isn't publicly listed yet", () => {
  it("says they joined the board but need a social handle to appear", () => {
    const lines = signedInNextStepLines({
      profileUrl: "https://whoburnedmore.com/u/erin",
      boardUrl: "https://whoburnedmore.com/boards/ABC",
      needsSocial: true,
    }).join("\n");
    expect(lines).toContain("You joined the board");
    expect(lines).toContain("add a social handle");
    expect(lines).not.toContain("You're on the board");
  });
});

describe("scopeWarningLines", () => {
  it("warns when a requested board or org wasn't joined", async () => {
    const { scopeWarningLines } = await import("../src/output.js");
    expect(scopeWarningLines({ board: "AB12" }, {}).join("")).toContain('Didn\'t join friends board "AB12"');
    expect(scopeWarningLines({ org: "acme" }, {}).join("")).toContain("add --pass=CODE");
    expect(scopeWarningLines({ org: "acme", orgCode: "x" }, {}).join("")).toContain("check the org name and the --pass code");
  });
  it("stays quiet when the join was confirmed or nothing was requested", async () => {
    const { scopeWarningLines } = await import("../src/output.js");
    expect(scopeWarningLines({ board: "AB12" }, { boardUrl: "https://whoburnedmore.com/boards/AB12" })).toEqual([]);
    expect(scopeWarningLines({ org: "acme" }, { orgBoardUrl: "https://acme.whoburnedmore.com" })).toEqual([]);
    expect(scopeWarningLines({}, {})).toEqual([]);
  });
});

describe("syncSummaryLine", () => {
  it("shows the account total, rank when listed, and days covered", async () => {
    const { syncSummaryLine } = await import("../src/output.js");
    const entries = [{ date: "2026-11-06" }, { date: "2026-11-06" }, { date: "2026-11-07" }];
    expect(syncSummaryLine({ totalTokens: 662_700, rank: 2, listed: true }, entries)).toBe(
      "  662.7K tokens on your account · #2 all-time · this sync covered 2 days",
    );
    expect(syncSummaryLine({ totalTokens: 662_700, rank: 2, listed: false }, entries)).not.toContain("#2");
    expect(syncSummaryLine({ rank: 2 }, entries)).toBeNull();
  });
});
