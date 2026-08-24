import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("publishes whoburnedmore while preserving the installed-app identity", async () => {
  const [project, plist] = await Promise.all([read("project.yml"), read("Info.plist")]);

  assert.match(project, /^name: BurnBar$/m);
  assert.match(project, /^  BurnBar:$/m);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER: com\.whoburnedmore\.burnbar/);
  assert.match(project, /CFBundleName: whoburnedmore/);
  assert.match(project, /CFBundleDisplayName: whoburnedmore/);
  assert.match(project, /INFOPLIST_KEY_CFBundleName: whoburnedmore/);
  assert.match(project, /INFOPLIST_KEY_CFBundleDisplayName: whoburnedmore/);
  assert.match(project, /GENERATE_INFOPLIST_FILE: "NO"/);
  assert.match(project, /SUFeedURL: https:\/\/github\.com\/arhxam\/whoburnedmore\/releases\/latest\/download\/appcast\.xml/);
  assert.match(project, /SUPublicEDKey: 9kMJHuWCAYyBMx48e30Xh4g7qABppEKiPkQ5rdQE9vo=/);

  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>\$\(EXECUTABLE_NAME\)<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.whoburnedmore\.burnbar<\/string>/);
  assert.match(plist, /<key>CFBundleName<\/key>\s*<string>whoburnedmore<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>whoburnedmore<\/string>/);
});

test("removes the retired BurnBar name from user-visible Swift strings", async () => {
  const publicFiles = [
    "Sources/BurnBar/DebugWindow.swift",
    "Sources/BurnBar/IslandSurfaceView.swift",
    "Sources/BurnBar/OnboardingWindow.swift",
    "Sources/BurnBar/PopoverView.swift",
    "Sources/BurnBar/SettingsWindow.swift",
    "Sources/BurnBar/StatusItemController.swift",
    "Sources/BurnBarCore/UpdatePreferences.swift",
  ];

  for (const file of publicFiles) {
    const source = await read(file);
    const oldPublicStrings = source.match(/"[^"\n]*BurnBar[^"\n]*"/g) ?? [];
    assert.deepEqual(oldPublicStrings, [], `${file} still exposes ${oldPublicStrings.join(", ")}`);
  }
});

test("creates byte-identical primary and compatibility DMGs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "wbm-dmg-test-"));
  const scripts = path.join(temp, "scripts");
  const fakeBin = path.join(temp, "bin");
  await mkdir(path.join(temp, "dist", "BurnBar.app"), { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(temp, "dist", "BurnBar.app", "marker"), "signed-app");
  await writeFile(path.join(scripts, "make-dmg.sh"), await read("scripts/make-dmg.sh"));
  await writeFile(
    path.join(fakeBin, "hdiutil"),
    '#!/usr/bin/env bash\nprintf "deterministic-dmg" > "${@: -1}"\n'
  );
  await writeFile(path.join(fakeBin, "codesign"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(path.join(fakeBin, "hdiutil"), 0o755);
  await chmod(path.join(fakeBin, "codesign"), 0o755);

  const result = spawnSync("bash", [path.join(scripts, "make-dmg.sh")], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const primary = await readFile(path.join(temp, "dist", "whoburnedmore.dmg"));
  const compatibility = await readFile(path.join(temp, "dist", "BurnBar.dmg"));
  assert.deepEqual(compatibility, primary);
});

test("feeds new installs the primary DMG while retaining the old asset", async () => {
  const [generate, publish, release, metadata, verifier] = await Promise.all([
    read("scripts/generate-appcast.sh"),
    read("scripts/publish-release.sh"),
    read("scripts/release.sh"),
    read("scripts/verify-update-metadata.mjs"),
    read("scripts/verify-update-artifacts.sh"),
  ]);

  assert.match(generate, /STAGE\/whoburnedmore\.dmg/);
  assert.match(generate, /STAGE\/whoburnedmore\.md/);
  assert.match(generate, /dist\/whoburnedmore\.md/);
  assert.match(generate, /dist\/BurnBar\.md/);
  assert.match(generate, /cmp -s dist\/whoburnedmore\.md dist\/BurnBar\.md/);
  assert.match(metadata, /releases\/download\/v\$\{project\.marketingVersion\}\/whoburnedmore\.dmg/);
  assert.match(publish, /dist\/whoburnedmore\.dmg/);
  assert.match(publish, /dist\/BurnBar\.dmg/);
  assert.match(publish, /cmp -s "\$PUBLISHED_DMG" "\$PUBLISHED_COMPAT_DMG"/);
  assert.match(publish, /cmp -s "\$PUBLISHED_NOTES" "\$PUBLISHED_COMPAT_NOTES"/);
  assert.match(release, /cmp -s dist\/whoburnedmore\.dmg dist\/BurnBar\.dmg/);
  assert.match(verifier, /Print :CFBundleDisplayName/);
  assert.match(verifier, /Print :CFBundleName/);
  assert.match(verifier, /Print :CFBundleIdentifier/);
  assert.match(verifier, /Print :CFBundleExecutable/);
});

test("documents the public name and compatibility boundary", async () => {
  const [readme, packageJSON] = await Promise.all([read("README.md"), read("package.json")]);
  assert.match(readme, /^# whoburnedmore$/m);
  assert.match(readme, /internal[\s\S]*`BurnBar`[\s\S]*compatibility/i);
  assert.equal(JSON.parse(packageJSON).description.startsWith("whoburnedmore —"), true);
});
