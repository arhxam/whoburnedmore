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
