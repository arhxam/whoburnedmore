import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityNoticeLines, detectAntigravity } from "../src/antigravity.js";

describe("detectAntigravity", () => {
  it("is true only when the Antigravity data dir exists under HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "wbm-ag-"));
    try {
      const env = { HOME: home } as NodeJS.ProcessEnv;
      expect(detectAntigravity(env)).toBe(false);
      await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });
      expect(detectAntigravity(env)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("also detects the Antigravity CLI and IDE data roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "wbm-ag-"));
    try {
      const env = { HOME: home } as NodeJS.ProcessEnv;
      await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
      expect(detectAntigravity(env)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("antigravityNoticeLines", () => {
  it("names the readable ledger and is honest about uncountable older logs", () => {
    const lines = antigravityNoticeLines();
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join(" ").toLowerCase();
    expect(text).toContain("antigravity");
    expect(text).toContain("conversations/*.db");
    // Older encrypted-only history must still be described as uncountable.
    expect(text).toMatch(/encrypted/);
    expect(text).toMatch(/can'?t be counted/);
  });
});
