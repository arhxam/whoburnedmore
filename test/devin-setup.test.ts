import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argumentProblem, parseAcuUsd, resolveCommand } from "../src/args.js";
import {
  clearDevinCloudConfig,
  collectDevinCloud,
  fetchDevinSelf,
  fetchDevinV3Sessions,
  loadDevinCloudConfig,
  mergeDevinCloudLocalAndV3Sessions,
  parseDevinCloudPayloads,
  readDevinCliCredentials,
  saveDevinCloudConfig,
} from "../src/devin-cloud.js";
import { formatDevinDiagnostics, runDevinSetup } from "../src/devin-setup.js";

const DAY1_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY2_MS = Date.UTC(2026, 10, 21, 12, 0, 0);
const NOW = Date.UTC(2026, 10, 24);
const DAY1 = new Date(DAY1_MS).toLocaleDateString("en-CA");
const DAY2 = new Date(DAY2_MS).toLocaleDateString("en-CA");

function makeCredsHome(): { home: string; env: NodeJS.ProcessEnv; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "wbm-devin-setup-"));
  const devinData = join(home, ".local", "share", "devin");
  mkdirSync(devinData, { recursive: true });
  writeFileSync(
    join(devinData, "credentials.toml"),
    [
      'windsurf_api_key = "devin-session-secret-token"',
      'api_server_url = "https://server.codeium.com"',
      'devin_api_url = "https://api.devin.ai"',
    ].join("\n") + "\n",
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    WHOBURNEDMORE_CONFIG_DIR: join(home, ".config", "whoburnedmore"),
  };
  return { home, env, configPath: join(home, ".config", "whoburnedmore", "devin-cloud.json") };
}

describe("setup-devin CLI args", () => {
  it("resolves setup-devin command and validates its flags strictly", () => {
    expect(resolveCommand(["setup-devin", "--status"])).toBe("setup-devin");
    expect(argumentProblem(["setup-devin", "--status"], "setup-devin")).toBeNull();
    expect(argumentProblem(["setup-devin", "--reset"], "setup-devin")).toBeNull();
    expect(argumentProblem(["setup-devin", "--use-devin-cli", "--acu-usd=2.25"], "setup-devin")).toBeNull();
    expect(parseAcuUsd(["setup-devin", "--acu-usd=2.25"])).toBe(2.25);
    expect(parseAcuUsd(["setup-devin", "--acu-usd", "$3.5"])).toBe(3.5);

    // Must reject setup-devin-only flags on default run / sync so they never trigger an upload.
    expect(argumentProblem(["--status"], "run")).toMatch(/only works with `setup-devin`/);
    expect(argumentProblem(["--reset"], "run")).toMatch(/only works with `setup-devin`/);
    expect(argumentProblem(["--use-devin-cli"], "sync")).toMatch(/only works with `setup-devin`/);
    expect(argumentProblem(["--acu-usd=2.25"], "run")).toMatch(/only works with `setup-devin`/);
    expect(argumentProblem(["setup-devin", "--acu-usd=-1"], "setup-devin")).toMatch(/positive number/);
  });
});

describe("devin-cloud.json config, credentials.toml, /v3/self, and v3 sessions merge", () => {
  it("saves, loads, and clears devin-cloud.json and reads credentials.toml", () => {
    const { home, env, configPath } = makeCredsHome();
    try {
      const creds = readDevinCliCredentials(env);
      expect(creds).toMatchObject({
        apiKey: "devin-session-secret-token",
        devinApiUrl: "https://api.devin.ai",
        apiServerUrl: "https://server.codeium.com",
      });

      expect(loadDevinCloudConfig(env, configPath)).toBeNull();
      expect(
        saveDevinCloudConfig(
          { useLocalCliCredentials: true, orgId: "org-1", userId: "user-1", acuUsd: 2.5 },
          env,
          configPath,
        ),
      ).toBe(true);
      expect(loadDevinCloudConfig(env, configPath)).toEqual({
        useLocalCliCredentials: true,
        orgId: "org-1",
        userId: "user-1",
        acuUsd: 2.5,
      });
      expect(clearDevinCloudConfig(env, configPath)).toBe(true);
      expect(loadDevinCloudConfig(env, configPath)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fetches /v3/self and paginates /v3/organizations/{org_id}/sessions", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            principal_type: "windsurf_session",
            user_id: "user-1",
            user_name: "Test User",
            devin_sessions_org_id: "org-99",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ session_id: "aaa", acus_consumed: 0.5, updated_at: Math.floor(DAY1_MS / 1000) }],
            has_next_page: true,
            end_cursor: "cur-2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ session_id: "bbb", on_demand_usage: 1.25, updated_at: Math.floor(DAY2_MS / 1000) }],
            has_next_page: false,
            end_cursor: null,
          }),
          { status: 200 },
        ),
      );

    const self = await fetchDevinSelf("tok", { fetchImpl: fetchMock });
    expect(self).toMatchObject({
      principalType: "windsurf_session",
      userId: "user-1",
      userName: "Test User",
      orgId: "org-99",
    });

    const sessions = await fetchDevinV3Sessions("tok", "org-99", {
      userId: "user-1",
      fetchImpl: fetchMock,
    });
    expect(sessions).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("merges local acp-messages sessions with v3 sessions without double counting", () => {
    const cursor = Buffer.from(JSON.stringify({ session: "devin-s1" })).toString("base64");
    const meta = {
      source_history: JSON.stringify({ replayedTail: { end: { cursor } } }),
      info: JSON.stringify({ configOptions: [{ id: "org_id", currentValue: "org-1" }, { id: "devin_version", currentValue: "devin-2-5" }] }),
    };
    const localSession = parseDevinCloudPayloads(
      meta,
      [
        JSON.stringify({
          content: {
            _meta: {
              "cognition.ai/timestamp": new Date(DAY1_MS).toISOString(),
              "cognition.ai/acuAmount": 0.25, // $0.50 at $2/ACU
            },
          },
        }),
      ],
      "s1.db",
      NOW,
    )!;

    const entries = mergeDevinCloudLocalAndV3Sessions(
      [localSession],
      [
        // Same session as local, API reports 0 (Max/Pro plan) -> local $0.50 wins!
        { session_id: "s1", acus_consumed: 0, updated_at: Math.floor(DAY1_MS / 1000) },
        // Webapp-only session not in Desktop cache -> API $3.00 included!
        {
          session_id: "s2",
          acus_consumed: 1.5,
          selected_devin_mode: "swe-2-high",
          updated_at: Math.floor(DAY2_MS / 1000),
        },
        // Teams on-demand overage session -> $4.50 included!
        {
          session_id: "s3",
          acus_consumed: 0,
          on_demand_usage: 4.5,
          devin_mode: "normal",
          updated_at: Math.floor(DAY2_MS / 1000),
        },
      ],
      2.0,
      NOW,
    );

    expect(entries).toHaveLength(3);
    expect(entries.find((e) => e.date === DAY1 && e.model === "devin-2-5")?.costUSD).toBe(0.5);
    expect(entries.find((e) => e.date === DAY2 && e.model === "swe-2-high")?.costUSD).toBe(3.0);
    expect(entries.find((e) => e.date === DAY2 && e.model === "devin-cloud")?.costUSD).toBe(4.5);
  });

  it("collectDevinCloud uses saved devin-cloud.json automatically when online, never when offline", async () => {
    const { home, env, configPath } = makeCredsHome();
    try {
      saveDevinCloudConfig(
        {
          useLocalCliCredentials: true,
          orgId: "org-1",
          userId: "user-1",
          acuUsd: 2.0,
        },
        env,
        configPath,
      );
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ session_id: "web-1", acus_consumed: 2.0, updated_at: Math.floor(DAY1_MS / 1000) }],
            has_next_page: false,
          }),
          { status: 200 },
        ),
      );

      // Offline: never touches fetch
      const offline = await collectDevinCloud({
        offline: true,
        env,
        configPath,
        acpMessagesDirs: [join(home, "no-acp")],
        now: NOW,
        fetchImpl: fetchMock,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(offline.entries).toEqual([]);

      // Online: reads credentials.toml via saved useLocalCliCredentials and fetches sessions
      const online = await collectDevinCloud({
        offline: false,
        env,
        configPath,
        acpMessagesDirs: [join(home, "no-acp")],
        now: NOW,
        fetchImpl: fetchMock,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(online.found).toBe(true);
      expect(online.entries[0]).toMatchObject({ date: DAY1, tool: "devin-cloud", costUSD: 4.0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runDevinSetup interactive & non-interactive flows", () => {
  it("supports --use-devin-cli, --status (redacting secrets), --acu-usd, and --reset", async () => {
    const { home, env, configPath } = makeCredsHome();
    const logs: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/v3/self")) {
        return new Response(
          JSON.stringify({
            principal_type: "windsurf_session",
            user_id: "user-abc",
            user_name: "Alice",
            devin_sessions_org_id: "org-xyz",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [], has_next_page: false }), { status: 200 });
    });

    try {
      const r1 = await runDevinSetup(
        { useDevinCli: true, acuUsd: 2.25 },
        { env, configPath, acpMessagesDirs: [join(home, "no-acp")], cliRoots: [join(home, "no-cli")], fetchImpl: fetchMock, log: (l) => logs.push(l), now: NOW },
      );
      expect(r1.saved).toBe(true);
      expect(r1.config).toMatchObject({
        useLocalCliCredentials: true,
        orgId: "org-xyz",
        userId: "user-abc",
        userName: "Alice",
        acuUsd: 2.25,
      });

      // --status must show org/user/rate and NEVER leak any token
      logs.length = 0;
      await runDevinSetup(
        { status: true },
        { env, configPath, acpMessagesDirs: [join(home, "no-acp")], cliRoots: [join(home, "no-cli")], fetchImpl: fetchMock, log: (l) => logs.push(l), now: NOW },
      );
      const out = logs.join("\n");
      expect(out).toContain("org-xyz");
      expect(out).toContain("$2.25/ACU");
      expect(out).not.toContain("devin-session-secret-token");

      // --acu-usd updates rate in place
      const r2 = await runDevinSetup(
        { acuUsd: 3.0 },
        { env, configPath, acpMessagesDirs: [join(home, "no-acp")], cliRoots: [join(home, "no-cli")], fetchImpl: fetchMock, log: () => {}, now: NOW },
      );
      expect(r2.config?.acuUsd).toBe(3.0);
      expect(r2.config?.useLocalCliCredentials).toBe(true);

      // --reset clears saved config
      await runDevinSetup({ reset: true }, { env, configPath, log: () => {} });
      expect(loadDevinCloudConfig(env, configPath)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("supports interactive PAT setup (option 2) and never prints the secret key", async () => {
    const { home, env, configPath } = makeCredsHome();
    const logs: string[] = [];
    const answers = ["2", "cog_super_secret_pat_12345", "2.50"];
    let idx = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/v3/self")) {
        return new Response(
          JSON.stringify({ principal_type: "user", user_id: "user-pat", user_name: "Bob", org_id: "org-pat" }),
          { status: 200 },
        );
      }
      if (u.includes("/consumption/daily")) {
        return new Response(
          JSON.stringify({ consumption_by_date: [{ date: DAY1, acus: 1.5, acus_by_product: { devin: 1.5 } }] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const res = await runDevinSetup(
        {},
        {
          env,
          configPath,
          acpMessagesDirs: [join(home, "no-acp")],
          cliRoots: [join(home, "no-cli")],
          fetchImpl: fetchMock,
          isTTY: true,
          ask: async () => answers[idx++] ?? "",
          log: (l) => logs.push(l),
          now: NOW,
        },
      );
      expect(res.saved).toBe(true);
      expect(res.config).toMatchObject({
        apiKey: "cog_super_secret_pat_12345",
        orgId: "org-pat",
        userId: "user-pat",
        acuUsd: 2.5,
      });
      expect(logs.join("\n")).not.toContain("cog_super_secret_pat_12345");
      expect(logs.join("\n")).toContain("Enterprise daily consumption API is enabled");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("supports interactive Analytics v2alpha key setup (option 3) with exact tokens", async () => {
    const { home, env, configPath } = makeCredsHome();
    const logs: string[] = [];
    const answers = ["3", "svc_secret_analytics_key", "user-42", ""];
    let idx = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/v3/self")) {
        return new Response(JSON.stringify({ principal_type: "windsurf_session", user_id: "user-42", org_id: "org-42" }), { status: 200 });
      }
      if (u.includes("/api/v2alpha/analytics/consumption")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                timestamp: DAY1,
                model_uid: "claude-sonnet-4-5",
                tokens: { input_tokens: 5000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0 },
              },
            ],
            pagination: { next_page_cursor: null },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const res = await runDevinSetup(
        {},
        {
          env,
          configPath,
          acpMessagesDirs: [join(home, "no-acp")],
          cliRoots: [join(home, "no-cli")],
          fetchImpl: fetchMock,
          isTTY: true,
          ask: async () => answers[idx++] ?? "",
          log: (l) => logs.push(l),
          now: NOW,
        },
      );
      expect(res.saved).toBe(true);
      expect(res.config).toMatchObject({
        analyticsServiceKey: "svc_secret_analytics_key",
        userId: "user-42",
      });
      const out = logs.join("\n");
      expect(out).not.toContain("svc_secret_analytics_key");
      expect(out).toContain("Granular per-model token counts detected");

      // formatDevinDiagnostics also never exposes keys
      const diagLines = formatDevinDiagnostics(
        {
          localCliLogs: 0,
          hasSessionsDb: true,
          desktopCloudSessions: 1,
          desktopCloudAcus: 0.5,
          hasCliCredentials: true,
          savedConfig: res.config,
          configFile: configPath,
        },
        env,
      ).join("\n");
      expect(diagLines).not.toContain("svc_secret_analytics_key");
      expect(diagLines).toContain("Analytics v2alpha key (saved)");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
