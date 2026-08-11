import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

describe("CLI release provenance", () => {
  it("refuses dirty/non-main/diverged source and pushes the exact source before npm publish", () => {
    const ship = readFileSync(resolve(root, "scripts/ship.mjs"), "utf8");
    expect(ship).toContain('capture("git", ["-C", ROOT, "status", "--porcelain"])');
    expect(ship).toContain('capture("git", ["-C", ROOT, "branch", "--show-current"])');
    expect(ship).toContain('capture("git", ["-C", ROOT, "rev-parse", "HEAD"])');
    expect(ship).toContain('capture("git", ["-C", ROOT, "rev-parse", "origin/main"])');

    const push = ship.indexOf('run("git", ["-C", ROOT, "push", "--quiet"]');
    const publish = ship.indexOf('run("npm", ["publish", "--access", "public"]');
    expect(push).toBeGreaterThan(0);
    expect(publish).toBeGreaterThan(push);
  });

  it("allows OIDC publishing only from the exact current origin/main commit", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/publish-cli.yml"),
      "utf8",
    );
    expect(workflow).toContain("git fetch origin main");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"');
    expect(workflow).toContain("npm install -g npm@11.6.2");
    expect(workflow).not.toContain("npm install -g npm@latest");
  });
});
