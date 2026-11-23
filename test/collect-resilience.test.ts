import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Make the optional Cline/Roo and Continue readers throw. Before 0.9.25 the
// rejection escaped collectAll's Promise.all and failed the whole sync, so no
// tool's usage (here: Claude Code) was submitted at all.
vi.mock("../src/native/vscode-agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/native/vscode-agents.js")>()),
  collectVscodeAgent: vi.fn(async () => {
    throw new Error("corrupt cache row");
  }),
}));
vi.mock("../src/continue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/continue.js")>()),
  collectContinue: vi.fn(async () => {
    throw new Error("unexpected Continue layout");
  }),
}));

vi.mock("../src/antigravity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/antigravity.js")>()),
  detectAntigravity: vi.fn(() => false),
  collectAntigravity: vi.fn(),
}));

const { collectAntigravity, detectAntigravity } = await import("../src/antigravity.js");
const { collectAll } = await import("../src/collect.js");

const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "WHOBURNEDMORE_CONFIG_DIR",
  "WHOBURNEDMORE_PRICING_OFFLINE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
let saved: Record<string, string | undefined> = {};
let root = "";

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  root = await mkdtemp(join(tmpdir(), "wbm-collect-resilience-"));
  const projects = join(root, ".claude", "projects", "p");
  await mkdir(projects, { recursive: true });
  await mkdir(join(root, "xdg"), { recursive: true });
  Object.assign(process.env, {
    HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, ".claude"),
    CODEX_HOME: join(root, ".codex"), WHOBURNEDMORE_CONFIG_DIR: join(root, "cfg"),
    WHOBURNEDMORE_PRICING_OFFLINE: "1", XDG_CONFIG_HOME: join(root, "xdg"), XDG_DATA_HOME: join(root, "xdg"),
  });
  const ts = new Date(Date.now() - 86_400_000).toISOString();
  await writeFile(join(projects, "s.jsonl"), JSON.stringify({
    timestamp: ts, requestId: "r1",
    message: { role: "assistant", id: "m1", model: "claude-sonnet-4-5",
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }) + "\n");
});

afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

describe("collectAll resilience", () => {
  it("still returns other tools' usage when an optional reader throws", async () => {
    const result = await collectAll(undefined, { offline: true });
    expect(result.toolsFound).toContain("claude");
    expect(result.toolsFound).not.toContain("cline");
    expect(result.toolsFound).not.toContain("continue");
    const claude = result.entries.filter((e) => e.tool === "claude");
    expect(claude.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0)).toBe(30);
  }, 60_000);

  it("falls back to the direct Antigravity reader when bundled daily usage is empty", async () => {
    vi.mocked(detectAntigravity).mockReturnValueOnce(true);
    const row = {
      date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      tool: "antigravity", model: "gemini", inputTokens: 10, outputTokens: 5,
      cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 0,
      origin: "cli" as const, verified: false,
    };
    vi.mocked(collectAntigravity).mockResolvedValueOnce({
      entries: [row], found: true, filesScanned: 1,
    });
    const result = await collectAll(undefined, { offline: true });
    expect(result.entries.filter((entry) => entry.tool === "antigravity")).toEqual([row]);
  }, 60_000);
});
