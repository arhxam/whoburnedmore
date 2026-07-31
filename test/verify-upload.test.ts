import { describe, expect, it } from "vitest";
import type { ParsedRequest } from "../src/native/claude.js";
import { prepareVerifyUpload } from "../src/verify-upload.js";

const request = (key: string, ts: number, model = "claude-sonnet-4-6"): ParsedRequest => ({
  key,
  hasRealId: true,
  date: "2026-06-20",
  ts,
  model,
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationTokens: 2,
  cacheReadTokens: 20,
});

describe("prepareVerifyUpload", () => {
  it("marks a timed-out local scan as truncated even when it is below the row cap", () => {
    const prepared = prepareVerifyUpload([request("provider-id", 100)], true);
    expect(prepared.truncated).toBe(true);
    expect(prepared.records).toHaveLength(1);
  });

  it("caps to the most recent records and never exposes raw provider ids", () => {
    const prepared = prepareVerifyUpload(
      [request("old-secret", 100), request("new-secret", 300), request("mid-secret", 200)],
      false,
      2,
    );
    expect(prepared.truncated).toBe(true);
    expect(prepared.records.map((r) => r.ts)).toEqual([300, 200]);
    expect(prepared.records.every((r) => !r.reqHash.includes("secret"))).toBe(true);
  });

  it("normalizes an external model id to the shared schema limit", () => {
    const [record] = prepareVerifyUpload(
      [request("id", 100, `  ${"m".repeat(200)}  `)],
      false,
    ).records;
    expect(record.model).toHaveLength(128);
  });
});
