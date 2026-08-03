import { describe, expect, it } from "vitest";

import { parseEvent, serialize, type Event } from "../src/protocol.js";

describe("protocol NDJSON round-trip", () => {
  it("serializes one event per line and parses it back", () => {
    const events: Event[] = [
      { type: "hello", version: "1", pid: 123 },
      { type: "heartbeat", ts: "2026-08-02T00:00:00Z" },
      { type: "alert", kind: "threshold", provider: "codex", level: 80, percent: 83 },
      { type: "status", collecting: false, lastFullCollectAt: null },
    ];
    for (const e of events) {
      const line = serialize(e);
      expect(line).not.toContain("\n");
      expect(parseEvent(line)).toEqual(e);
    }
  });

  it("returns null for blank, garbage, and type-less lines instead of throwing", () => {
    expect(parseEvent("")).toBeNull();
    expect(parseEvent("   ")).toBeNull();
    expect(parseEvent("{not json")).toBeNull();
    expect(parseEvent('"a string"')).toBeNull();
    expect(parseEvent('{"foo": 1}')).toBeNull();
  });
});
