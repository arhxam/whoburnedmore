import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliHelpText } from "../src/index.js";

describe("CLI help and README", () => {
  it("documents the returning-user flags and account commands", () => {
    const help = cliHelpText();
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const text of [help, readme]) {
      expect(text).toContain("--open");
      expect(text).toContain("--no-open");
      expect(text).toContain("WHOBURNEDMORE_NO_OPEN=1");
      expect(text).toContain("whoami");
      expect(text).toContain("login");
      expect(text).toContain("logout");
    }
  });
});
