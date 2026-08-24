import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_COMMAND,
  PUBLIC_PRODUCT_NAME,
  cliInvocation,
} from "../src/brand.js";
import { defaultConfigDir } from "../src/config.js";

describe("public CLI brand compatibility", () => {
  it("uses the canonical product name without renaming the executable", () => {
    expect(PUBLIC_PRODUCT_NAME).toBe("whoburnedmore");
    expect(LEGACY_COMMAND).toBe("whoburnedmore");
    expect(cliInvocation()).toBe("npx whoburnedmore");
    expect(cliInvocation("--board=CODE")).toBe(
      "npx whoburnedmore --board=CODE",
    );
  });

  it("retains the existing user configuration path", () => {
    const previous = process.env.WHOBURNEDMORE_CONFIG_DIR;
    delete process.env.WHOBURNEDMORE_CONFIG_DIR;
    try {
      expect(defaultConfigDir()).toBe(
        join(homedir(), ".config", "whoburnedmore"),
      );
    } finally {
      if (previous === undefined) delete process.env.WHOBURNEDMORE_CONFIG_DIR;
      else process.env.WHOBURNEDMORE_CONFIG_DIR = previous;
    }
  });
});
