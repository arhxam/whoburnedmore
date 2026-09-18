import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { archiveMetadata, parseArguments, prepareArchive } from "../prepare-xcode-archive.mjs";

const info = {
  CFBundleIdentifier: "com.whoburnedmore.burnbar", CFBundleShortVersionString: "0.8.3",
  CFBundleVersion: "8003", CFBundleExecutable: "BurnBar", CFBundleDisplayName: "who & <burned> more",
  CFBundlePackageType: "APPL", CFBundleSupportedPlatforms: ["MacOSX"],
};
const signature = { identifier: info.CFBundleIdentifier, team: "84MFPMUB97", identity: "Developer ID Application: Arham Amin (84MFPMUB97)" };

test("archive metadata has Organizer's app schema and escapes values", () => {
  const xml = archiveMetadata(info, signature, "Burn&Bar.app", new Date("2026-09-19T00:00:00Z"));
  for (const field of ["ApplicationProperties", "ApplicationPath", "SigningIdentity", "Team", "CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"]) {
    assert.match(xml, new RegExp(`<key>${field}</key>`));
  }
  assert.match(xml, /Applications\/Burn&amp;Bar\.app/);
  assert.match(xml, /who &amp; &lt;burned&gt; more/);
  assert.match(xml, /<key>ArchiveVersion<\/key><integer>2<\/integer>/);
  assert.match(xml, /<date>2026-09-19T00:00:00Z<\/date>/);
});

test("rejects wrong bundle, team, identity, version and app path", () => {
  assert.throws(() => archiveMetadata({ ...info, CFBundleIdentifier: "other" }, signature, "BurnBar.app"), /identifier/);
  assert.throws(() => archiveMetadata(info, { ...signature, team: "wrong" }, "BurnBar.app"), /team/);
  assert.throws(() => archiveMetadata(info, { ...signature, identity: "Apple Development: Other" }, "BurnBar.app"), /Developer ID/);
  assert.throws(() => archiveMetadata({ ...info, CFBundleVersion: "0" }, signature, "BurnBar.app"), /positive/);
  assert.throws(() => archiveMetadata(info, signature, "../BurnBar.app"), /name/);
});

test("CLI requires explicit output and rejects unknown or missing arguments", () => {
  assert.throws(() => parseArguments([]), /explicit/);
  assert.throws(() => parseArguments(["--output"]), /Usage/);
  assert.throws(() => parseArguments(["--force", "yes"]), /Usage/);
  assert.equal(parseArguments(["--output", "build/my app.xcarchive"]).output, "build/my app.xcarchive");
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "burnbar-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "BurnBar.app");
  for (const path of ["Contents/MacOS/BurnBar", "Contents/Resources/ccusage", "Contents/Resources/burnbar-sidecar"]) {
    await mkdir(dirname(join(app, path)), { recursive: true });
    await writeFile(join(app, path), "fixture", { mode: 0o755 });
  }
  for (const name of ["BurnBarCore", "Sparkle"]) {
    await mkdir(join(app, `Contents/Frameworks/${name}.framework`), { recursive: true });
  }
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "/usr/bin/ditto") await cp(args[0], args[1], { recursive: true });
    if (command === "/usr/bin/plutil" && args[0] === "-convert") return { stdout: JSON.stringify(info) };
    if (command === "/usr/bin/codesign" && args[0] === "--display") return {
      stderr: `Identifier=${signature.identifier}\nTeamIdentifier=${signature.team}\nAuthority=${signature.identity}\n`,
    };
    return { stdout: "", stderr: "" };
  };
  return { root, app, calls, run, output: join(root, "Release.xcarchive") };
}

test("assembles exactly one top-level app and verifies source plus copied code", async (t) => {
  const f = await fixture(t);
  const result = await prepareArchive(f, { run: f.run });
  assert.equal(result.version, "0.8.3");
  assert.equal(result.build, "8003");
  assert.deepEqual(await readdir(join(f.output, "Products")), ["Applications"]);
  assert.deepEqual(await readdir(join(f.output, "Products/Applications")), ["BurnBar.app"]);
  assert.match(await readFile(join(f.output, "Info.plist"), "utf8"), /ApplicationProperties/);
  assert.equal(f.calls.filter(([command, args]) => command === "/usr/bin/codesign" && args.join(" ").startsWith("--verify --strict --deep")).length, 2);
  assert.ok(f.calls.every(([command]) => ["/usr/bin/codesign", "/usr/bin/ditto", "/usr/bin/plutil"].includes(command)));
  await assert.rejects(prepareArchive(f, { run: f.run }), /overwrite/);
});

test("refuses output inside app even through a directory symlink", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(f.app, alias);
  await assert.rejects(prepareArchive({ ...f, output: join(alias, "Unsafe.xcarchive") }, { run: f.run }), /inside/);
  assert.equal(f.calls.length, 0);
});

test("failed verification produces no archive and failed copy cleans only its output", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareArchive(f, { run: async () => { throw new Error("invalid signature"); } }), /signature/);
  await assert.rejects(readdir(f.output), { code: "ENOENT" });
  await assert.rejects(prepareArchive(f, { run: async (command, args) => {
    if (command === "/usr/bin/ditto") throw new Error("copy failed");
    return f.run(command, args);
  } }), /copy failed/);
  await assert.rejects(readdir(f.output), { code: "ENOENT" });
  assert.ok((await readdir(f.app)).includes("Contents"));
});
