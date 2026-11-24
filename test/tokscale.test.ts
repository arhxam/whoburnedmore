import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapTokscaleGraph,
  runTokscaleGraph,
  tokscaleEnv,
  TOKSCALE_EXCLUDED_CLIENTS,
  TOKSCALE_EXTRA_CLIENTS,
} from "../src/tokscale.js";
import { SOURCES } from "../src/collect.js";
import { VSCODE_AGENTS } from "../src/native/vscode-agents.js";

const NOW = Date.UTC(2026, 10, 24);

function graph(clients: Array<Record<string, unknown>>, date = "2026-11-20") {
  return { contributions: [{ date, clients }] };
}

describe("mapTokscaleGraph", () => {
  it("maps day × client × model rows, folding reasoning into output", () => {
    const entries = mapTokscaleGraph(
      graph([
        {
          client: "devin-cli",
          modelId: "claude-sonnet-5-5",
          tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 8, reasoning: 5 },
          cost: 1.25,
          messages: 3,
        },
      ]),
      TOKSCALE_EXTRA_CLIENTS,
      NOW,
    );
    expect(entries).toEqual([
      {
        date: "2026-11-20",
        tool: "devin",
        model: "claude-sonnet-5-5",
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationTokens: 8,
        cacheReadTokens: 50,
        costUSD: 1.25,
        origin: "cli",
        verified: false,
      },
    ]);
  });

  it("merges two tokscale clients that map to one tool on the same model", () => {
    const entries = mapTokscaleGraph(
      graph([
        { client: "devin-cli", modelId: "m", tokens: { input: 10 }, cost: 0.1 },
        { client: "devin-desktop", modelId: "m", tokens: { input: 5, output: 1 }, cost: 0.2 },
      ]),
      TOKSCALE_EXTRA_CLIENTS,
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: "devin", inputTokens: 15, outputTokens: 1 });
    expect(entries[0]!.costUSD).toBeCloseTo(0.3, 6);
  });

  it("drops clients outside the map, so an already-counted agent can never leak in", () => {
    const entries = mapTokscaleGraph(
      graph([
        { client: "claude", modelId: "claude-opus-5-5", tokens: { input: 1_000_000 } },
        { client: "codex", modelId: "gpt-5.5", tokens: { input: 1_000_000 } },
        { client: "zed", modelId: "claude-sonnet-5-5", tokens: { input: 7 } },
      ]),
      TOKSCALE_EXTRA_CLIENTS,
      NOW,
    );
    expect(entries.map((e) => e.tool)).toEqual(["zed"]);
  });

  it("defaults a missing model to the tool id and skips empty rows", () => {
    const entries = mapTokscaleGraph(
      graph([
        { client: "kiro", tokens: { input: 0, output: 0 }, cost: 0 },
        { client: "kiro", modelId: "  ", tokens: { output: 9 } },
      ]),
      TOKSCALE_EXTRA_CLIENTS,
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: "kiro", model: "kiro", outputTokens: 9 });
  });

  it("rejects implausible dates and malformed shapes without throwing", () => {
    expect(mapTokscaleGraph(null, TOKSCALE_EXTRA_CLIENTS, NOW)).toEqual([]);
    expect(mapTokscaleGraph({}, TOKSCALE_EXTRA_CLIENTS, NOW)).toEqual([]);
    expect(mapTokscaleGraph({ contributions: "x" }, TOKSCALE_EXTRA_CLIENTS, NOW)).toEqual([]);
    const row = { client: "zed", modelId: "m", tokens: { input: 1 } };
    expect(mapTokscaleGraph(graph([row], "2031-01-01"), TOKSCALE_EXTRA_CLIENTS, NOW)).toEqual([]);
    expect(mapTokscaleGraph(graph([row], "2026-02-31"), TOKSCALE_EXTRA_CLIENTS, NOW)).toEqual([]);
    expect(
      mapTokscaleGraph(
        { contributions: [null, { date: "2026-11-20", clients: [null, 4, row] }] },
        TOKSCALE_EXTRA_CLIENTS,
        NOW,
      ),
    ).toHaveLength(1);
  });

  it("prices a $0 row from our table when the model is known, keeps a recorded cost", () => {
    const [priced, recorded, unknown] = mapTokscaleGraph(
      graph([
        { client: "zed", modelId: "claude-sonnet-4-5", tokens: { input: 1_000_000 }, cost: 0 },
        { client: "kiro", modelId: "claude-sonnet-4-5", tokens: { input: 1_000_000 }, cost: 0.42 },
        { client: "crush", modelId: "totally-unknown-model-x", tokens: { input: 1_000_000 }, cost: 0 },
      ]),
      TOKSCALE_EXTRA_CLIENTS,
      NOW,
    );
    expect(priced!.costUSD).toBeGreaterThan(0);
    expect(recorded!.costUSD).toBe(0.42);
    expect(unknown!.costUSD).toBe(0);
  });

  it("negative/NaN token values clamp to zero", () => {
    const entries = mapTokscaleGraph(
      graph([{ client: "zed", modelId: "m", tokens: { input: -5, output: "NaN", cacheRead: 3 }, cost: -1 }]),
      TOKSCALE_EXTRA_CLIENTS,
      NOW,
    );
    expect(entries[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, costUSD: 0 });
  });
});

describe("tokscale client coverage", () => {
  const extra = Object.keys(TOKSCALE_EXTRA_CLIENTS);
  const excluded = Object.keys(TOKSCALE_EXCLUDED_CLIENTS);
  const ourOtherTools = new Set<string>([
    ...SOURCES,
    "cursor",
    "continue",
    ...VSCODE_AGENTS.map((a) => a.tool),
  ]);

  it("never takes a client that is also excluded", () => {
    expect(extra.filter((c) => excluded.includes(c))).toEqual([]);
  });

  it("never emits a tool id another reader already submits", () => {
    const clash = Object.values(TOKSCALE_EXTRA_CLIENTS).filter((t) => ourOtherTools.has(t));
    expect(clash).toEqual([]);
  });

  it("excludes every ccusage source tokscale can also read", () => {
    for (const source of SOURCES) {
      expect(TOKSCALE_EXTRA_CLIENTS[source]).toBeUndefined();
    }
  });

  it("includes Devin", () => {
    expect(TOKSCALE_EXTRA_CLIENTS["devin-cli"]).toBe("devin");
    expect(TOKSCALE_EXTRA_CLIENTS["devin-desktop"]).toBe("devin");
  });
});

describe("runTokscaleGraph", () => {
  it("opts the child out of telemetry and scheduling", () => {
    const env = tokscaleEnv({ PATH: "/bin" });
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.TOKSCALE_AUTOSUBMIT_SKIP_SCHEDULER).toBe("1");
    expect(env.PATH).toBe("/bin");
  });

  it("is a clean no-op when tokscale isn't installed", async () => {
    expect(await runTokscaleGraph({ clientMap: TOKSCALE_EXTRA_CLIENTS, bin: null })).toEqual({
      entries: [],
      ran: false,
      timedOut: false,
    });
  });

  it("runs offline, restricted to the mapped clients, and maps the report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-tokscale-"));
    const argsFile = join(dir, "args.json");
    const fake = join(dir, "fake-tokscale.mjs");
    writeFileSync(
      fake,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ argv: process.argv.slice(2), dnt: process.env.DO_NOT_TRACK }));
process.stdout.write(JSON.stringify({ contributions: [{ date: "2026-11-20", clients: [
  { client: "zed", modelId: "m", tokens: { input: 4, output: 2 }, cost: 0.5 },
  { client: "claude", modelId: "x", tokens: { input: 999 } }
] }] }));`,
    );
    chmodSync(fake, 0o755);
    const res = await runTokscaleGraph({
      clientMap: { zed: "zed" },
      bin: { cmd: process.execPath, prefixArgs: [fake] },
      now: NOW,
    });
    expect(res.ran).toBe(true);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({ tool: "zed", inputTokens: 4, outputTokens: 2 });
    const seen = JSON.parse((await import("node:fs")).readFileSync(argsFile, "utf8"));
    expect(seen.argv).toEqual(["graph", "--offline", "--no-spinner", "--client", "zed"]);
    expect(seen.dnt).toBe("1");
  });

  it("reports a timeout and takes nothing from a hung run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-tokscale-"));
    const fake = join(dir, "hang.mjs");
    writeFileSync(fake, "setInterval(() => {}, 1000);");
    const res = await runTokscaleGraph({
      clientMap: { zed: "zed" },
      bin: { cmd: process.execPath, prefixArgs: [fake] },
      timeoutMs: 300,
    });
    expect(res).toEqual({ entries: [], ran: false, timedOut: true });
  });

  it("takes nothing from non-JSON output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wbm-tokscale-"));
    const fake = join(dir, "junk.mjs");
    writeFileSync(fake, "process.stdout.write('not json');");
    const res = await runTokscaleGraph({
      clientMap: { zed: "zed" },
      bin: { cmd: process.execPath, prefixArgs: [fake] },
    });
    expect(res).toEqual({ entries: [], ran: false, timedOut: false });
  });
});

describe("installed tokscale", () => {
  // When tokscale is bumped and learns a new agent, this fails until someone
  // decides whether that agent is new coverage or would double-count.
  it("has every one of its clients classified as extra or excluded", async () => {
    const { resolveTokscaleBin } = await import("../src/tokscale.js");
    const bin = resolveTokscaleBin();
    if (!bin) return; // optional dependency absent on this platform
    const { spawnSync } = await import("node:child_process");
    const help = spawnSync(bin.cmd, [...bin.prefixArgs, "graph", "--help"], {
      encoding: "utf8",
    });
    const match = /possible values: ([^\]]+)\]/.exec(help.stdout ?? "");
    if (!match) return;
    const clients = match[1]!.split(",").map((c) => c.trim()).filter(Boolean);
    const unclassified = clients.filter(
      (c) => !(c in TOKSCALE_EXTRA_CLIENTS) && !(c in TOKSCALE_EXCLUDED_CLIENTS),
    );
    expect(unclassified).toEqual([]);
  });
});
