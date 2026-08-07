import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildSyncPayload } from "../src/sync.js";

describe("live leaderboard sync", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses the native cache path without launching the expensive slow collector", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-live-sync-"));
    roots.push(root);
    const marker = join(root, "slow-tier-ran");
    const fakeCcusage = join(root, "ccusage");
    writeFileSync(
      fakeCcusage,
      `#!/bin/sh\ntouch "${marker}"\nprintf '{"daily":[],"sessions":[]}\\n'\n`,
    );
    chmodSync(fakeCcusage, 0o755);

    await buildSyncPayload(
      {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CODEX_HOME: join(root, "codex"),
        BURNBAR_CACHE_DIR: join(root, "cache"),
        BURNBAR_CCUSAGE: fakeCcusage,
      },
      { nativeOnly: true },
    );

    expect(existsSync(marker)).toBe(false);
  });
});
