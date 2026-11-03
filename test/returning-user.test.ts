import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import {
  runLogin,
  runLogout,
  runWhoami,
  submitSignedIn,
} from "../src/index.js";
import type { SubmitPayload } from "../src/shared.js";

const { spawnMock, questions } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref() {} })),
  questions: [] as string[],
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawn: spawnMock };
});

vi.mock("../src/autosync.js", async () => {
  const actual = await vi.importActual<typeof import("../src/autosync.js")>(
    "../src/autosync.js",
  );
  return {
    ...actual,
    autoSyncInstalled: () => false,
    reconcileAutoSync: () => "noop" as const,
    uninstallAutoSync: () => "background sync removed",
    installAutoSync: () => "not installed by tests",
  };
});

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (prompt: string) => {
      questions.push(String(prompt));
      return "";
    },
    close() {},
  }),
}));

const payload: SubmitPayload = {
  cliVersion: "9.9.9",
  entries: [
    {
      date: "2026-06-01",
      tool: "claude",
      model: "claude",
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
    },
  ],
};

function submitBody(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    upserted: 1,
    totalTokens: 2,
    totalCostUSD: 0,
    rank: 8,
    profileUrl: "https://whoburnedmore.com/u/ada",
    ...extra,
  };
}

function flags(extra: { open?: boolean; noOpen?: boolean } = {}) {
  return {
    dryRun: false,
    noSubmit: false,
    local: false,
    quiet: false,
    open: extra.open ?? false,
    noOpen: extra.noOpen ?? false,
  };
}

describe("returning-user commands", () => {
  let dir = "";
  let prevConfig: string | undefined;
  let prevNoOpen: string | undefined;
  let logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn> | undefined;
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  beforeEach(() => {
    questions.length = 0;
    spawnMock.mockClear();
    logs = [];
    dir = mkdtempSync(join(tmpdir(), "wbm-return-"));
    prevConfig = process.env.WHOBURNEDMORE_CONFIG_DIR;
    prevNoOpen = process.env.WHOBURNEDMORE_NO_OPEN;
    process.env.WHOBURNEDMORE_CONFIG_DIR = dir;
    delete process.env.WHOBURNEDMORE_NO_OPEN;
    saveConfig(dir, {
      anonKey: "a".repeat(64),
      cliToken: "tok",
      handle: "ada",
      refreshToken: "refresh-1",
      deviceBoundAt: 1,
      autoSyncOptOut: true,
    });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unexpected network");
      }),
    );
  });

  afterEach(() => {
    logSpy?.mockRestore();
    vi.unstubAllGlobals();
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    if (prevConfig === undefined) delete process.env.WHOBURNEDMORE_CONFIG_DIR;
    else process.env.WHOBURNEDMORE_CONFIG_DIR = prevConfig;
    if (prevNoOpen === undefined) delete process.env.WHOBURNEDMORE_NO_OPEN;
    else process.env.WHOBURNEDMORE_NO_OPEN = prevNoOpen;
  });

  function stubSubmit(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  it("whoami, login, and logout report the stored session without a browser", async () => {
    await runWhoami();
    expect(logs.join("\n")).toContain("Signed in as @ada");

    logs.length = 0;
    await runLogin();
    expect(logs.join("\n")).toContain("Already signed in as @ada");

    logs.length = 0;
    await runLogout();
    expect(logs.join("\n")).toContain("Signed out");
    expect(loadConfig()?.cliToken).toBeUndefined();
    expect(loadConfig()?.refreshToken).toBeUndefined();
    expect(loadConfig()?.handle).toBeUndefined();
    expect(loadConfig()?.anonKey).toBe("a".repeat(64));

    logs.length = 0;
    await runWhoami();
    expect(logs.join("\n")).toContain("Not signed in");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("login without a terminal does not start device sign-in", async () => {
    saveConfig(dir, { anonKey: "a".repeat(64) });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    await runLogin();
    expect(logs.join("\n")).toContain("interactive terminal");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not open the dashboard for a returning run, --no-open, or a non-TTY", async () => {
    stubSubmit(submitBody());
    await submitSignedIn("tok", payload, flags(), true, false);
    expect(logs.join("\n")).toContain(
      "@ada · rank #8 · https://whoburnedmore.com/u/ada",
    );
    expect(spawnMock).not.toHaveBeenCalled();

    spawnMock.mockClear();
    await submitSignedIn("tok", payload, flags(), true, true);
    expect(spawnMock).toHaveBeenCalled();
    expect(String(spawnMock.mock.calls[0]?.[1])).toContain("https://whoburnedmore.com/u/ada");

    spawnMock.mockClear();
    await submitSignedIn("tok", payload, flags({ noOpen: true }), true, true);
    expect(spawnMock).not.toHaveBeenCalled();

    spawnMock.mockClear();
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    await submitSignedIn("tok", payload, flags({ open: true }), true, true);
    expect(spawnMock).not.toHaveBeenCalled();

    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    process.env.WHOBURNEDMORE_NO_OPEN = "1";
    await submitSignedIn("tok", payload, flags({ open: true }), true, true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("opens the dashboard when --open is set on a returning run", async () => {
    stubSubmit(submitBody());
    await submitSignedIn("tok", payload, flags({ open: true }), true, false);
    expect(spawnMock).toHaveBeenCalled();
    expect(String(spawnMock.mock.calls[0]?.[1])).toContain("https://whoburnedmore.com/u/ada");
  });

  it("asks Verify now? once per suppression event and defaults to No", async () => {
    stubSubmit(submitBody({ suppressed: true, quarantinedDates: ["2026-06-01"] }));
    await submitSignedIn("tok", payload, flags(), true, false);
    const asked = questions.filter((q) => q.includes("Verify now?"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("[y/N]");
    expect(loadConfig()?.verifyPromptedFor).toBe("suppressed:2026-06-01");
    expect(spawnMock).not.toHaveBeenCalled();

    questions.length = 0;
    await submitSignedIn("tok", payload, flags(), true, false);
    expect(questions.filter((q) => q.includes("Verify now?"))).toHaveLength(0);

    stubSubmit(submitBody({ suppressed: true, quarantinedDates: ["2026-06-03"] }));
    await submitSignedIn("tok", payload, flags(), true, false);
    expect(questions.filter((q) => q.includes("Verify now?"))).toHaveLength(1);
    expect(loadConfig()?.verifyPromptedFor).toBe("suppressed:2026-06-03");
  });
});
