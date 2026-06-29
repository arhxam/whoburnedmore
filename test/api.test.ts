import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/config.js";
loadEnv();

import {
  anonRemove,
  anonSubmit,
  anonVisibility,
  boardClaimUrl,
  claimUrl,
  isOpenableUrl,
  isTrustedWebUrl,
  redeemServerInstall,
  resolveOpenTarget,
} from "../src/api.js";

describe("isTrustedWebUrl — never auto-open a hostile server URL", () => {
  it("accepts only an https URL on our own web host", () => {
    expect(isTrustedWebUrl("https://whoburnedmore.com/d/abc-def")).toBe(true);
    expect(isTrustedWebUrl("https://whoburnedmore.com/boards/xyz")).toBe(true);
  });
  it("rejects wrong host, wrong scheme, and dangerous schemes", () => {
    for (const bad of [
      "https://evil.com/d/abc", // wrong host
      "https://whoburnedmore.com.evil.com/d/abc", // look-alike host
      "http://whoburnedmore.com/d/abc", // downgraded scheme (base is https)
      "javascript:alert(document.cookie)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "calculator://x",
      "-a /System/Applications/Calculator.app", // arg-injection into `open`
      "--background https://evil.com",
      "",
      "not a url",
    ]) {
      expect(isTrustedWebUrl(bad), bad).toBe(false);
    }
  });
});

describe("isOpenableUrl — what may reach the OS opener", () => {
  it("allows http(s) and local file URLs only", () => {
    expect(isOpenableUrl("https://whoburnedmore.com/d/x")).toBe(true);
    expect(isOpenableUrl("http://localhost:3001/d/x")).toBe(true);
    expect(isOpenableUrl("file:///home/u/.config/whoburnedmore/dashboard.html")).toBe(true);
  });
  it("blocks dangerous schemes and flag-injection", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:msgbox(1)",
      "customapp://run",
      "-a Calculator",
      "--args evil",
      "ssh://host",
    ]) {
      expect(isOpenableUrl(bad), bad).toBe(false);
    }
  });
});

describe("claimUrl", () => {
  it("appends the anon key as a URL fragment (the claim handoff)", () => {
    expect(claimUrl("https://whoburnedmore.com/d/abc-def", "secretkey123")).toBe(
      "https://whoburnedmore.com/d/abc-def#k=secretkey123",
    );
  });

  it("URL-encodes the key", () => {
    expect(claimUrl("http://x/d/s", "a b/c")).toBe("http://x/d/s#k=a%20b%2Fc");
  });
});

describe("boardClaimUrl", () => {
  it("carries the claim key AND the dashboard slug as fragment params", () => {
    expect(
      boardClaimUrl(
        "https://whoburnedmore.com/boards/AB12",
        "molten-goblin-482",
        "secretkey123",
      ),
    ).toBe(
      "https://whoburnedmore.com/boards/AB12#k=secretkey123&u=molten-goblin-482",
    );
  });

  it("URL-encodes both the key and the slug", () => {
    expect(boardClaimUrl("http://x/boards/c", "a b", "a b/c")).toBe(
      "http://x/boards/c#k=a%20b%2Fc&u=a%20b",
    );
  });
});

describe("resolveOpenTarget — a run with --org lands on the org board", () => {
  const anonKey = "deadbeefcafef00d";
  it("opens the ORG board (with claim handoff) when the server returned one", () => {
    const { baseUrl, target } = resolveOpenTarget(
      {
        orgBoardUrl: "https://whoburnedmore.com/o/inventionnovelty/board",
        dashboardUrl: "https://whoburnedmore.com/d/cool-fox-12",
        slug: "cool-fox-12",
      },
      anonKey,
    );
    expect(baseUrl).toBe("https://whoburnedmore.com/o/inventionnovelty/board");
    expect(target).toContain("/o/inventionnovelty/board");
    expect(target).toContain(`#k=${anonKey}`);
  });
  it("prefers the org board over a friends board", () => {
    const { target } = resolveOpenTarget(
      {
        orgBoardUrl: "https://whoburnedmore.com/o/acme/board",
        boardUrl: "https://whoburnedmore.com/boards/xyz",
        dashboardUrl: "https://whoburnedmore.com/d/cool-fox-12",
        slug: "cool-fox-12",
      },
      anonKey,
    );
    expect(target).toContain("/o/acme/board");
    expect(target).not.toContain("/boards/xyz");
  });
  it("falls back to friends board, then the dashboard claim URL", () => {
    expect(
      resolveOpenTarget(
        {
          boardUrl: "https://whoburnedmore.com/boards/xyz",
          dashboardUrl: "https://whoburnedmore.com/d/cool-fox-12",
          slug: "cool-fox-12",
        },
        anonKey,
      ).target,
    ).toContain("/boards/xyz");
    expect(
      resolveOpenTarget(
        { dashboardUrl: "https://whoburnedmore.com/d/cool-fox-12", slug: "cool-fox-12" },
        anonKey,
      ).target,
    ).toContain("/d/cool-fox-12");
  });
});

describe("anon visibility + remove", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /v1/anon/visibility with the key + listed flag", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await anonVisibility("k".repeat(32), false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/anon\/visibility$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      anonKey: "k".repeat(32),
      listed: false,
    });
  });

  it("DELETEs /v1/anon with the key", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await anonRemove("k".repeat(32));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/anon$/);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ anonKey: "k".repeat(32) });
  });

  it("throws with the server error on non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "nope" }), { status: 404 }),
      ),
    );
    await expect(anonRemove("k".repeat(32))).rejects.toThrow("nope");
  });
});

describe("server install redeem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the one-time install token with this machine's anon key", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            handle: "alice",
            profileUrl: "https://whoburnedmore.com/u/alice",
            mergedDays: 0,
            alreadyLinked: false,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await redeemServerInstall("tok.secret", "k".repeat(32));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/server-install\/redeem$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      token: "tok.secret",
      anonKey: "k".repeat(32),
    });
    expect(result.handle).toBe("alice");
  });

  it("throws the server error on rejected links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "already linked" }), { status: 409 }),
      ),
    );
    await expect(
      redeemServerInstall("tok.secret", "k".repeat(32)),
    ).rejects.toThrow("already linked");
  });
});

describe("network resilience", () => {
  afterEach(() => vi.unstubAllGlobals());

  const payload = { cliVersion: "0.3.0", entries: [] };

  it("does not crash on a non-JSON 502 (Azure cold start / gateway)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      ),
    );
    // Must throw a clean message, not a raw JSON 'Unexpected token <' parse error.
    await expect(anonSubmit("k".repeat(32), payload)).rejects.toThrow(
      /temporarily unavailable/,
    );
  });

  it("throws a friendly message when the network is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(anonSubmit("k".repeat(32), payload)).rejects.toThrow(
      /couldn't reach the leaderboard server/,
    );
  });
});
