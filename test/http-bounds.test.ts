import { describe, expect, it } from "vitest";
import { readJsonResponseCapped } from "../src/http-bounds.js";

describe("readJsonResponseCapped", () => {
  it("parses a bounded JSON response", async () => {
    await expect(
      readJsonResponseCapped<{ ok: boolean }>(
        new Response('{"ok":true}', { headers: { "content-length": "11" } }),
        64,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects declared and streamed bodies above the cap", async () => {
    await expect(
      readJsonResponseCapped(new Response("{}", { headers: { "content-length": "1000" } }), 16),
    ).rejects.toThrow(/too large/);
    await expect(
      readJsonResponseCapped(new Response(JSON.stringify({ value: "x".repeat(100) })), 16),
    ).rejects.toThrow(/too large/);
  });
});
