import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/config.js";
loadEnv();

import type { SubmitPayload } from "../src/shared.js";
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

function deps(
  accept: boolean,
  dashboardUrl = "https://whoburnedmore.com/d/s-l-u-g",
): PublishDeps & {
  anonSubmit: ReturnType<typeof vi.fn>;
  openBrowser: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    confirm: vi.fn(async () => accept),
    ensureAnonKey: vi.fn(() => "a".repeat(32)),
    anonSubmit: vi.fn(async () => ({
      ok: true as const,
      upserted: 1,
      totalTokens: 2,
      totalCostUSD: 0,
      slug: "s-l-u-g",
      dashboardUrl,
    })),
    openBrowser: vi.fn(),
    log: vi.fn(),
  };
}

describe("publishLocal", () => {
  it("submits anonymously and opens the dashboard with the claim handoff on accept", async () => {
    const d = deps(true);
    const published = await publishLocal(payload, d);
    expect(published).toBe(true);
    expect(d.anonSubmit).toHaveBeenCalledOnce();
    expect(d.openBrowser).toHaveBeenCalledWith(
      expect.stringContaining("#k="),
    );
  });

  it("stays offline on decline — never submits or opens a browser", async () => {
    const d = deps(false);
    const published = await publishLocal(payload, d);
    expect(published).toBe(false);
    expect(d.anonSubmit).not.toHaveBeenCalled();
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("never auto-opens a dashboard URL on an untrusted host (hostile/MITM'd server)", async () => {
    // A malicious or MITM'd server returns an off-host URL; we still publish but
    // must NOT hand it to the OS opener — same host gate as the core submit path.
    const d = deps(true, "https://evil.example.com/d/s-l-u-g");
    const published = await publishLocal(payload, d);
    expect(published).toBe(true);
    expect(d.anonSubmit).toHaveBeenCalledOnce();
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it("strips terminal control bytes from the server dashboard URL before printing", async () => {
    const d = deps(true, "https://whoburnedmore.com/d/\u001b]0;pwned\u0007x");
    await publishLocal(payload, d);
    // Join with a space, not "\n": a newline is itself a control byte the regex
    // below would (wrongly) flag — that would mask whether the SERVER text was
    // sanitized. We only care that no control bytes survive within the printed text.
    const printed = d.log.mock.calls.map((c) => String(c[0])).join(" ");
    // eslint-disable-next-line no-control-regex -- asserting control bytes are gone
    expect(printed).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
