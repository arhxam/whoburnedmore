import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { readTextFileSyncCapped } from "../src/safe-local-file.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bounded local file reads", () => {
  it("reads regular files and refuses data over the byte limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "wbm-file-"));
    directories.push(directory);
    const path = join(directory, "data.json");
    writeFileSync(path, "1234");
    expect(readTextFileSyncCapped(path, 4)).toBe("1234");
    expect(readTextFileSyncCapped(path, 3)).toBeNull();
    expect(readTextFileSyncCapped(directory, 4)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without hanging the collector", () => {
    const directory = mkdtempSync(join(tmpdir(), "wbm-fifo-"));
    directories.push(directory);
    const fifo = join(directory, "config.json");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    // Run the actual helper in a disposable child: a regression in synchronous
    // open() must time out this assertion, not hang the entire test runner.
    const modulePath = fileURLToPath(new URL("../src/safe-local-file.ts", import.meta.url));
    const source = readTextFileSyncCapped(modulePath, 64 * 1024)!;
    const javascript = transformSync(source, { loader: "ts", format: "cjs" }).code;
    const child = spawnSync(process.execPath, ["-e", `${javascript}\nprocess.stdout.write(JSON.stringify(readTextFileSyncCapped(process.argv[1], 1024)));`, fifo], {
      encoding: "utf8",
      timeout: 2_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("null");
  });
});
