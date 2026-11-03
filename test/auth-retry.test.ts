import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import {
  runRemove,
  runVerify,
  runVisibility,
  submitLocalPublish,
  submitSignedIn,
} from "../src/index.js";
import type { SubmitPayload } from "../src/shared.js";

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

vi.mock("../src/native/claude.js", async () => {
  const actual = await vi.importActual<typeof import("../src/native/claude.js")>(
    "../src/native/claude.js",
  );
  return {
    ...actual,
    collectClaudeRequests: vi.fn(async () => ({
      requests: [
        {
          key: "k1",
          hasRealId: true,
          date: "2026-06-01",
          ts: 1_700_000_000_000,
          model: "claude",
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      ],
      found: true,
    })),
  };
});

const { questions } = vi.hoisted(() => ({ questions: [] as string[] }));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (prompt: string) => {
      questions.push(String(prompt));
      // Empty accepts the historical [Y/n] default, so remove/verify proceed.
      return "";
    },
    close() {},
  }),
}));

const SESSION_EXPIRED = "Your session expired — signing you in again.";

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

const quietFlags = {
  dryRun: false,
  noSubmit: false,
  local: false,
  quiet: true,
};

const submitOk = {
  ok: true as const,
  upserted: 1,
  totalTokens: 2,
  totalCostUSD: 0,
  rank: 4,
  profileUrl: "https://whoburnedmore.com/u/alice",
};

interface Hit {
  url: string;
  method: string;
  auth: string;
  body: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installApi(opts: {
  refresh: "ok" | "fail";
  match: (url: string) => boolean;
  ok: unknown;
}): { hits: Hit[]; tokenAtDeviceStart: () => string | undefined } {
  const hits: Hit[] = [];
  let endpointHits = 0;
  let tokenAtDeviceStart: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      hits.push({
        url,
        method: init?.method ?? "GET",
        auth: headers.get("authorization") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url.endsWith("/v1/auth/cli/refresh")) {
        if (opts.refresh === "fail") return json(401, { error: "refresh rejected" });
        return json(200, { ok: true, token: "fresh-token", handle: "alice" });
      }
      if (url.endsWith("/v1/auth/device")) {
        tokenAtDeviceStart = loadConfig()?.cliToken;
        return json(200, {
          deviceCode: "dev",
          userCode: "ABCD-EFGH",
          // Untrusted on purpose: the retry test must not launch a browser.
          verifyUrl: "https://example.com/device",
          expiresInSeconds: 30,
          pollIntervalSeconds: 1,
        });
      }
      if (url.endsWith("/v1/auth/device/token")) {
        return json(200, {
          status: "ok",
          token: "device-token",
          handle: "alice",
          refreshToken: "refresh-2",
        });
      }
      if (url.includes("/v1/me/devices/bind")) {
        return json(200, { ok: true });
      }
      if (opts.match(url)) {
        endpointHits += 1;
        if (endpointHits === 1) return json(401, { error: "invalid CLI token" });
        return json(200, opts.ok);
      }
      return json(500, { error: `unexpected ${url}` });
    }),
  );
  return { hits, tokenAtDeviceStart: () => tokenAtDeviceStart };
}

const commands: Array<{
  name: string;
  match: (url: string) => boolean;
  ok: unknown;
  run: () => Promise<unknown>;
  confirm: string | null;
  /** remove drops the session after a successful delete. */
  clearsOnSuccess: boolean;
}> = [
  {
    name: "submit",
    match: (url) => url.endsWith("/v1/submit"),
    ok: submitOk,
    run: () => submitSignedIn("expired-token", payload, quietFlags, true),
    confirm: null,
    clearsOnSuccess: false,
  },
  {
    name: "local publish",
    match: (url) => url.endsWith("/v1/submit"),
    ok: submitOk,
    run: () => submitLocalPublish("expired-token", payload),
    confirm: null,
    clearsOnSuccess: false,
  },
  {
    name: "public",
    match: (url) => url.endsWith("/v1/cli/visibility"),
    ok: { ok: true, listed: true, eligible: true },
    run: () => runVisibility(true),
    confirm: null,
    clearsOnSuccess: false,
  },
  {
    name: "remove",
    match: (url) => url.endsWith("/v1/cli/usage"),
    ok: { ok: true, deletedDays: 2 },
    run: () => runRemove(),
    confirm: "Delete your usage data?",
    clearsOnSuccess: true,
  },
  {
    name: "verify",
    match: (url) => url.endsWith("/v1/verify"),
    ok: {
      ok: true,
      verdict: "review",
      score: 1,
      relisted: false,
      checks: [],
      message: "received",
    },
    run: () => runVerify(),
    confirm: "Send this breakdown",
    clearsOnSuccess: false,
  },
];

describe("withAuthRetry across signed-in commands", () => {
  let dir = "";
  let prevConfig: string | undefined;
  let logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn> | undefined;
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  beforeEach(() => {
    questions.length = 0;
    logs = [];
    dir = mkdtempSync(join(tmpdir(), "wbm-auth-"));
    prevConfig = process.env.WHOBURNEDMORE_CONFIG_DIR;
    process.env.WHOBURNEDMORE_CONFIG_DIR = dir;
    saveConfig(dir, {
      anonKey: "a".repeat(64),
      cliToken: "expired-token",
      handle: "alice",
      refreshToken: "refresh-1",
      deviceBoundAt: 1,
    });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
    vi.unstubAllGlobals();
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    if (prevConfig === undefined) delete process.env.WHOBURNEDMORE_CONFIG_DIR;
    else process.env.WHOBURNEDMORE_CONFIG_DIR = prevConfig;
  });

  describe("401 then a successful refresh", () => {
    it.each(commands)(
      "$name retries once with the refreshed token and does not re-sign-in",
      async (command) => {
        const api = installApi({
          refresh: "ok",
          match: command.match,
          ok: command.ok,
        });
        await command.run();
        const refreshes = api.hits.filter((hit) =>
          hit.url.endsWith("/v1/auth/cli/refresh"),
        );
        const calls = api.hits.filter((hit) => command.match(hit.url));
        expect(refreshes).toHaveLength(1);
        expect(refreshes[0]?.body).toContain("refresh-1");
        expect(calls.map((hit) => hit.auth)).toEqual([
          "Bearer expired-token",
          "Bearer fresh-token",
        ]);
        expect(api.hits.some((hit) => hit.url.endsWith("/v1/auth/device"))).toBe(false);
        expect(logs.join("\n")).not.toContain(SESSION_EXPIRED);
        expect(loadConfig()?.cliToken).toBe(
          command.clearsOnSuccess ? undefined : "fresh-token",
        );
        if (command.confirm) {
          expect(questions.filter((q) => q.includes(command.confirm!))).toHaveLength(1);
        }
      },
    );
  });

  describe("401 then a failed refresh", () => {
    it.each(commands)(
      "$name clears the dead sign-in and signs in again",
      async (command) => {
        const api = installApi({
          refresh: "fail",
          match: command.match,
          ok: command.ok,
        });
        await command.run();
        const refreshes = api.hits.filter((hit) =>
          hit.url.endsWith("/v1/auth/cli/refresh"),
        );
        const calls = api.hits.filter((hit) => command.match(hit.url));
        expect(refreshes).toHaveLength(1);
        expect(api.tokenAtDeviceStart()).toBeUndefined();
        expect(logs.join("\n")).toContain(SESSION_EXPIRED);
        expect(calls.map((hit) => hit.auth)).toEqual([
          "Bearer expired-token",
          "Bearer device-token",
        ]);
        expect(loadConfig()?.cliToken).toBe(
          command.clearsOnSuccess ? undefined : "device-token",
        );
        if (command.confirm) {
          expect(questions.filter((q) => q.includes(command.confirm!))).toHaveLength(1);
        }
      },
      20_000,
    );
  });
});
