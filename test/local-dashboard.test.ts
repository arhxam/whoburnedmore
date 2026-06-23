import { describe, expect, it } from "vitest";
import type { DailyUsageEntry } from "../src/shared.js";
import { renderDashboardHtml } from "../src/local-dashboard.js";

function entry(overrides: Partial<DailyUsageEntry> = {}): DailyUsageEntry {
  return {
    date: "2026-06-10",
    tool: "claude",
    model: "claude-opus-4-7",
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    cacheCreationTokens: 500_000,
    cacheReadTokens: 8_000_000,
    costUSD: 12.5,
    ...overrides,
  };
}

describe("renderDashboardHtml", () => {
  it("produces a self-contained HTML page with the totals and tools", () => {
    const html = renderDashboardHtml([
      entry(),
      entry({ tool: "codex", model: "gpt-5.3-codex" }),
    ]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("your local burn");
    // 2 × 9.7M = 19.4M tokens
    expect(html).toContain("19.4M");
    expect(html).toContain("claude");
    expect(html).toContain("codex");
    // fully inline — no external script/stylesheet references
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("href=\"http");
  });

  it("renders a Connect form that POSTs the base64 payload to the web /connect route", () => {
    const entries = [entry()];
    const payload = { cliVersion: "9.9.9", entries };
    const html = renderDashboardHtml(entries, new Date(), {
      payload,
      webBaseUrl: "https://whoburnedmore.com",
    });
    expect(html).toContain("Connect your account");
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="https://whoburnedmore.com/connect"');
    // tells the user to run the plain command for background sync
    expect(html).toContain("npx whoburnedmore");
    // payload is embedded as base64 and round-trips back to the original JSON
    const m = html.match(/name="payload" value="([^"]+)"/);
    expect(m).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(m![1], "base64").toString("utf8"));
    expect(decoded).toEqual(payload);
  });

  it("omits the Connect form when no connect options are given", () => {
    const html = renderDashboardHtml([entry()]);
    expect(html).not.toContain("Connect your account");
    expect(html).not.toContain("/connect");
  });

  it("escapes model names and renders an empty state without crashing", () => {
    const html = renderDashboardHtml([
      entry({ model: "<img src=x onerror=alert(1)>" }),
    ]);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");

    const empty = renderDashboardHtml([]);
    expect(empty).toContain("no usage found");
  });

  it("escapes a <script>-laden tool name (no raw script tag in the output)", () => {
    // A user's own transcript could carry an HTML-laden tool/project name; the local
    // dashboard must never reflect it unescaped (self-XSS when they open the file).
    const html = renderDashboardHtml([
      entry({ tool: "<script>alert(1)</script>" }),
    ]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
