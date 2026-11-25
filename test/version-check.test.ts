import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import {
  isNewerVersion,
  parseVersion,
  readLatestVersionCache,
  readLatestVersionCacheSync,
  refreshLatestVersion,
  updateNoticeLines,
} from "../src/version-check.js";

async function tmpCachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "wbm-version-")), "latest-version-cache.json");
}

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise((resolve) => s.close(resolve));
  }
});

async function serveVersion(version: string | null): Promise<string> {
  const server = createServer((_req, res) => {
    if (version === null) {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  return `http://127.0.0.1:${addr.port}/latest`;
}

describe("parseVersion", () => {
  it("parses strict x.y.z versions", () => {
    expect(parseVersion("0.9.28")).toEqual([0, 9, 28]);
    expect(parseVersion("1.20.3")).toEqual([1, 20, 3]);
  });

  it("rejects junk, partial versions and non-strings", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("0.9")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(42)).toBeNull();
    expect(parseVersion("0.9.28\n\u001b[31m")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("compares numerically, not lexically", () => {
    expect(isNewerVersion("0.9.27", "0.9.28")).toBe(true);
    expect(isNewerVersion("0.9.28", "0.10.0")).toBe(true);
    expect(isNewerVersion("0.9.28", "1.0.0")).toBe(true);
    // numeric, not lexical: patch 10 beats patch 9 even though "10" < "9" as a string
    expect(isNewerVersion("0.9.9", "0.9.10")).toBe(true);
    expect(isNewerVersion("0.9.28", "0.9.10")).toBe(false);
  });

  it("is false for equal, older, or unparseable versions", () => {
    expect(isNewerVersion("0.9.28", "0.9.28")).toBe(false);
    expect(isNewerVersion("0.9.28", "0.9.27")).toBe(false);
    expect(isNewerVersion("0.9.28", "garbage")).toBe(false);
    expect(isNewerVersion("0.9.28", null)).toBe(false);
  });
});

describe("refreshLatestVersion", () => {
  it("fetches, validates and caches the latest version", async () => {
    const url = await serveVersion("0.9.29");
    const path = await tmpCachePath();
    const env = { WHOBURNEDMORE_VERSION_CHECK_URL: url } as NodeJS.ProcessEnv;
    const latest = await refreshLatestVersion({ env, cachePath: path });
    expect(latest).toBe("0.9.29");
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.version).toBe("0.9.29");
    expect(typeof onDisk.fetchedAt).toBe("number");
  });

  it("serves a fresh cache without touching the network", async () => {
    const path = await tmpCachePath();
    await writeFile(path, JSON.stringify({ fetchedAt: Date.now(), version: "0.9.30" }));
    // An unreachable URL proves no fetch happens on the fresh-cache path.
    const env = {
      WHOBURNEDMORE_VERSION_CHECK_URL: "http://127.0.0.1:1/nope",
    } as NodeJS.ProcessEnv;
    expect(await refreshLatestVersion({ env, cachePath: path })).toBe("0.9.30");
  });

  it("falls back to a stale cache when the fetch fails", async () => {
    const path = await tmpCachePath();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await writeFile(path, JSON.stringify({ fetchedAt: weekAgo, version: "0.9.28" }));
    const env = {
      WHOBURNEDMORE_VERSION_CHECK_URL: "http://127.0.0.1:1/nope",
    } as NodeJS.ProcessEnv;
    expect(await refreshLatestVersion({ env, cachePath: path })).toBe("0.9.28");
  });

  it("returns null when there is no cache and the fetch fails, and never throws", async () => {
    const env = {
      WHOBURNEDMORE_VERSION_CHECK_URL: "http://127.0.0.1:1/nope",
    } as NodeJS.ProcessEnv;
    await expect(
      refreshLatestVersion({ env, cachePath: await tmpCachePath() }),
    ).resolves.toBeNull();
  });

  it("rejects a malformed registry answer", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "not-a-version" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    const env = {
      WHOBURNEDMORE_VERSION_CHECK_URL: `http://127.0.0.1:${addr.port}/latest`,
    } as NodeJS.ProcessEnv;
    expect(await refreshLatestVersion({ env, cachePath: await tmpCachePath() })).toBeNull();
  });

  it("stays fully offline when offline is passed or the env opt-out is set", async () => {
    const url = await serveVersion("0.9.99");
    const path = await tmpCachePath();
    const env = { WHOBURNEDMORE_VERSION_CHECK_URL: url } as NodeJS.ProcessEnv;
    expect(await refreshLatestVersion({ env, cachePath: path, offline: true })).toBeNull();
    expect(
      await refreshLatestVersion({
        env: { ...env, WHOBURNEDMORE_VERSION_CHECK_OFFLINE: "1" } as NodeJS.ProcessEnv,
        cachePath: path,
      }),
    ).toBeNull();
  });
});

describe("readLatestVersionCache / readLatestVersionCacheSync", () => {
  it("reads a valid cache file both ways", async () => {
    const path = await tmpCachePath();
    await writeFile(path, JSON.stringify({ fetchedAt: 123, version: "0.9.28" }));
    expect((await readLatestVersionCache(path))?.version).toBe("0.9.28");
    expect(readLatestVersionCacheSync(path)?.version).toBe("0.9.28");
  });

  it("treats missing and corrupt caches as absent", async () => {
    const missing = await tmpCachePath();
    expect(await readLatestVersionCache(missing)).toBeNull();
    expect(readLatestVersionCacheSync(missing)).toBeNull();

    const corrupt = await tmpCachePath();
    await writeFile(corrupt, "{not json");
    expect(await readLatestVersionCache(corrupt)).toBeNull();
    expect(readLatestVersionCacheSync(corrupt)).toBeNull();

    const wrongShape = await tmpCachePath();
    await writeFile(wrongShape, JSON.stringify({ fetchedAt: "now", version: 42 }));
    expect(await readLatestVersionCache(wrongShape)).toBeNull();
  });
});

describe("updateNoticeLines", () => {
  it("explains the pinned background sync and how to advance it", () => {
    const lines = updateNoticeLines("0.9.27", "0.9.28").join("\n");
    expect(lines).toContain("v0.9.28");
    expect(lines).toContain("v0.9.27");
    expect(lines).toContain("pinned");
    expect(lines).toContain("npx whoburnedmore@latest");
  });

  it("prints nothing for unparseable input", () => {
    expect(updateNoticeLines("garbage", "0.9.28")).toEqual([]);
    expect(updateNoticeLines("0.9.27", "0.9.28[31m")).toEqual([]);
  });
});
