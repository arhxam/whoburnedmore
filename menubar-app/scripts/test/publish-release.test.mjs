import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("../publish-release.sh", import.meta.url), "utf8");

test("authorizes repository write permission rather than one GitHub username", () => {
  assert.match(script, /viewerPermission/);
  assert.match(script, /ADMIN\|MAINTAIN\|WRITE/);
  assert.doesNotMatch(script, /expected arhxam/);
});

test("waits for latest-release assets after creating the immutable release", () => {
  assert.match(script, /release .* already exists; update archives are immutable/);
  assert.match(script, /gh release edit "\$TAG" --repo "\$REPOSITORY" --latest/);
  assert.match(script, /wait_for_asset "\$FEED_URL"/);
  assert.match(script, /wait_for_asset "\$DMG_URL"/);
  assert.match(script, /wait_for_asset "\$NOTES_URL"/);
  assert.match(script, /--retry-all-errors/);
});

test("uploads release notes and verifies the downloaded production pair", () => {
  assert.match(script, /dist\/BurnBar\.md/);
  assert.match(script, /verify-update-artifacts\.sh "\$PUBLISHED_DMG" "\$PUBLISHED_APPCAST"/);
  assert.match(script, /BURNBAR_CHECK_PUBLISHED_BUILD=0/);
});
