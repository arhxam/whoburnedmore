import { createHash } from "node:crypto";
import type { VerifyRequestRecord } from "./shared.js";
import type { ParsedRequest } from "./native/claude.js";

/** Convert a local scan into the bounded, content-free verification payload. */
export function prepareVerifyUpload(
  requests: ParsedRequest[],
  scanTimedOut: boolean,
  cap = 50_000,
): { records: VerifyRequestRecord[]; truncated: boolean } {
  const sorted = requests.slice().sort((a, b) => b.ts - a.ts);
  const truncated = scanTimedOut || sorted.length > cap;
  const capped = sorted.length > cap ? sorted.slice(0, cap) : sorted;
  const records = capped.map((r) => ({
    date: r.date,
    ts: r.ts,
    tool: "claude",
    model: r.model.trim().slice(0, 128) || "unknown",
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    cacheReadTokens: r.cacheReadTokens,
    reqHash: createHash("sha256").update(r.key).digest("hex").slice(0, 32),
  }));
  return { records, truncated };
}
