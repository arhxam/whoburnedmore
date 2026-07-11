import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindDeviceKey,
  isOpenableUrl,
  isTrustedWebUrl,
  redeemServerInstall,
  refreshCliToken,
  removeUsage,
  setVisibility,
  submit,
  UnauthorizedError,
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

describe("signed-in visibility (`private`/`public`)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the listed flag with the bearer token to /v1/cli/visibility", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, listed: false, eligible: true }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await setVisibility("cli-jwt", false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/cli\/visibility$/);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer cli-jwt",
    );
    expect(JSON.parse(init.body as string)).toEqual({ listed: false });
    expect(res).toEqual({ listed: false, eligible: true });
  });

  it("reports an ineligible (no-social) account instead of claiming success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, listed: false, eligible: false }),
            { status: 200 },
          ),
      ),
    );
    expect(await setVisibility("cli-jwt", true)).toEqual({
      listed: false,
      eligible: false,
    });
  });

  it("throws UnauthorizedError on a 401 so the caller can re-sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "invalid CLI token" }), {
            status: 401,
          }),
      ),
    );
    await expect(setVisibility("dead-jwt", true)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("throws with the server error on other non-200s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
      ),
    );
    await expect(setVisibility("cli-jwt", true)).rejects.toThrow("nope");
  });
});

describe("signed-in usage removal (`remove`)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("DELETEs /v1/cli/usage with the bearer token and returns the deleted count", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, deletedDays: 42 }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await removeUsage("cli-jwt");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/cli\/usage$/);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer cli-jwt",
    );
    expect(res).toEqual({ deletedDays: 42 });
  });

  it("throws UnauthorizedError on a 401 and the server error otherwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "invalid CLI token" }), {
            status: 401,
          }),
      ),
    );
    await expect(removeUsage("dead-jwt")).rejects.toBeInstanceOf(UnauthorizedError);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
      ),
    );
    await expect(removeUsage("cli-jwt")).rejects.toThrow("nope");
  });
});

describe("silent CLI token refresh (device-key self-heal)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the machine key and returns the fresh token + handle", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, token: "fresh-jwt", handle: "alice" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await refreshCliToken("k".repeat(32));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/auth\/cli\/refresh$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ anonKey: "k".repeat(32) });
    expect(result).toEqual({ token: "fresh-jwt", handle: "alice" });
  });

  it("returns null (never throws) on an unbound key, a blocked account, or network trouble", async () => {
    for (const status of [404, 403, 400]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "nope" }), { status }),
        ),
      );
      expect(await refreshCliToken("k".repeat(32))).toBeNull();
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await refreshCliToken("k".repeat(32))).toBeNull();
  });

  it("returns null on a 200 that carries no token (defensive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    expect(await refreshCliToken("k".repeat(32))).toBeNull();
  });
});

describe("device-key bind (rotation-proofing)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the key with the bearer token; 200 and 409 are definitive", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, alreadyLinked: false }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await bindDeviceKey("jwt-token", "k".repeat(32))).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/v1\/me\/devices\/bind$/);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({ anonKey: "k".repeat(32) });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "owned elsewhere" }), {
            status: 409,
          }),
      ),
    );
    expect(await bindDeviceKey("jwt-token", "k".repeat(32))).toBe(true);
  });

  it("returns false on transient failures so a later submit retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    expect(await bindDeviceKey("jwt-token", "k".repeat(32))).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await bindDeviceKey("jwt-token", "k".repeat(32))).toBe(false);
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
    await expect(submit("cli-jwt", payload)).rejects.toThrow(
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
    await expect(submit("cli-jwt", payload)).rejects.toThrow(
      /couldn't reach the leaderboard server/,
    );
  });
});
