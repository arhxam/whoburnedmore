import { describe, expect, it, vi } from "vitest";
import type { SubmitPayload, SubmitResponse } from "../src/shared.js";
import { publishLocal, type PublishDeps } from "../src/publish.js";

const payload: SubmitPayload = {
  cliVersion: "0.1.0",
  entries: [
    {
      date: "2026-06-13",
      tool: "claude",
      model: "claude-opus-4-7",
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      origin: "cli",
      verified: false,
    },
  ],
};

function response(profileUrl: string): SubmitResponse {
  return {
    ok: true,
    upserted: 1,
    totalTokens: 2,
    totalCostUSD: 0,
    rank: 7,
    profileUrl,
  };
}

function deps(
  accept: boolean,
  opts?: { profileUrl?: string; signedIn?: boolean },
): PublishDeps & {
  signIn: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  openBrowser: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  const profileUrl = opts?.profileUrl ?? "https://whoburnedmore.com/u/alice";
  const signedIn = opts?.signedIn ?? true;
  return {
    confirm: vi.fn(async () => accept),
    signIn: vi.fn(async () =>
      signedIn ? { token: "cli-jwt", handle: "alice" } : null,
    ),
    submit: vi.fn(async () => response(profileUrl)),
    openBrowser: vi.fn(),
    log: vi.fn(),
  };
}

describe("publishLocal (signed-in — anonymous publish is retired)", () => {
  it("signs in, submits with the minted token, and opens the profile on accept", async () => {
    const d = deps(true);
    const published = await publishLocal(payload, d);
    expect(published).toBe(true);
    expect(d.signIn).toHaveBeenCalledOnce();
    expect(d.submit).toHaveBeenCalledWith("cli-jwt", payload);
    expect(d.openBrowser).toHaveBeenCalledWith("https://whoburnedmore.com/u/alice");
  });

  it("stays offline on decline — never signs in, submits, or opens a browser", async () => {
    const d = deps(false);
    const published = await publishLocal(payload, d);
    expect(published).toBe(false);
    expect(d.signIn).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("stays offline when sign-in aborts/times out — nothing is submitted", async () => {
    const d = deps(true, { signedIn: false });
    const published = await publishLocal(payload, d);
    expect(published).toBe(false);
    expect(d.submit).not.toHaveBeenCalled();
    expect(d.openBrowser).not.toHaveBeenCalled();
    const printed = d.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("Nothing left your machine");
  });

  it("never auto-opens a profile URL on an untrusted host (hostile/MITM'd server)", async () => {
    const d = deps(true, { profileUrl: "https://evil.example.com/u/alice" });
    const published = await publishLocal(payload, d);
    expect(published).toBe(true);
    expect(d.submit).toHaveBeenCalledOnce();
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("strips terminal control bytes from the server profile URL before printing", async () => {
    const d = deps(true, {
      profileUrl: "https://whoburnedmore.com/u/\u001b]0;pwned\u0007x",
    });
    await publishLocal(payload, d);
    // Concatenate WITHOUT a separator — joining on "\n" would itself inject a
    // 0x0a control byte, so the assertion below could never pass regardless of
    // sanitization. We're asserting the server-supplied URL's control bytes
    // (the ESC/BEL of its OSC sequence) never reach the terminal, which
    // sanitizeServerText guarantees.
    const printed = d.log.mock.calls.map((c) => String(c[0])).join("");
    // eslint-disable-next-line no-control-regex -- asserting control bytes are gone
    expect(printed).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
