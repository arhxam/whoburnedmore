import { describe, expect, it, vi } from "vitest";
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

  it("cancels the transfer when its declared size is rejected before reading", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "1000" },
    });
    await expect(readJsonResponseCapped(response, 16)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("cancels an unknown-length stream as soon as it exceeds the cap", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(17)); },
      cancel,
    }));
    await expect(readJsonResponseCapped(response, 16)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
