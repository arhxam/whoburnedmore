import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseRequirement, verifyPackagedApp } from "../verify-packaged-app.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wbm-packaged-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "BurnBar.app");
  const resources = join(app, "Contents/Resources");
  await mkdir(resources, { recursive: true });
  const sidecar = join(resources, "burnbar-sidecar");
  await writeFile(sidecar, "fixture", { mode: 0o755 });
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: file === sidecar ? "0.8.3\n" : "", stderr: "" };
  };
  return { app, resources, sidecar, calls, run };
}

test("requires exact Apple Developer ID team and identifiers before executing packaged helper", async (t) => {
  const f = await fixture(t);
  assert.equal(await verifyPackagedApp(f.app, "0.8.3", { run: f.run }), "0.8.3");
  assert.equal(f.calls.length, 3);
  const [appCheck, sidecarCheck, execution] = f.calls;
  for (const check of [appCheck, sidecarCheck]) {
    assert.equal(check.file, "/usr/bin/codesign");
    assert.ok(check.args.includes("--verify"));
    assert.ok(check.args.includes("--strict"));
    assert.ok(check.args.includes("--test-requirement"));
    const requirement = check.args.at(-2);
    assert.match(requirement, /^=anchor apple generic/);
    assert.match(requirement, /certificate leaf\[subject\.OU\] = "84MFPMUB97"/);
    assert.match(requirement, /certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] exists/);
    assert.match(requirement, /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists/);
  }
  assert.ok(appCheck.args.includes("--deep"));
  assert.match(appCheck.args.at(-2), /identifier "com\.whoburnedmore\.burnbar"/);
  assert.match(sidecarCheck.args.at(-2), /identifier "burnbar-sidecar"/);
  assert.equal(execution.file, f.sidecar);
  assert.deepEqual(execution.args, ["version"]);
  assert.deepEqual(execution.options, { timeout: 10_000, maxBuffer: 1024 });
});

test("rejects notarization carriers of any disk image name without executing code", async (t) => {
  const f = await fixture(t);
  for (const name of ["whoburnedmore.dmg", "unexpected.DMG"]) {
    await writeFile(join(f.resources, name), "carrier");
    await assert.rejects(verifyPackagedApp(f.app, "0.8.3", { run: f.run }), /carrier/);
    await rm(join(f.resources, name));
  }
  assert.equal(f.calls.length, 0);
});

test("failed app or helper signature never reaches execution", async (t) => {
  const f = await fixture(t);
  for (const failureIndex of [1, 2]) {
    let count = 0;
    await assert.rejects(verifyPackagedApp(f.app, "0.8.3", { run: async (file) => {
      assert.equal(file, "/usr/bin/codesign");
      if (++count === failureIndex) throw new Error("wrong team or invalid signature");
      return { stdout: "" };
    } }), /wrong team/);
    assert.equal(count, failureIndex);
  }
});

test("rejects an old helper even if outer bundle metadata and signatures pass", async (t) => {
  const f = await fixture(t);
  await assert.rejects(verifyPackagedApp(f.app, "0.8.3", { run: async (file) => ({
    stdout: file === f.sidecar ? "0.8.2\n" : "",
  }) }), /sidecar version "0\.8\.2" != project 0\.8\.3/);
});

test("rejects a symlink helper and unexpected code identifiers", async (t) => {
  const f = await fixture(t);
  await rm(f.sidecar);
  await symlink("/bin/echo", f.sidecar);
  await assert.rejects(verifyPackagedApp(f.app, "0.8.3", { run: f.run }), /regular executable/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => releaseRequirement("arbitrary"), /Unexpected/);
});

test("DMG release gate invokes packaged verification with project version before success", async () => {
  const source = await readFile(new URL("../verify-update-artifacts.sh", import.meta.url), "utf8");
  const gate = source.indexOf('node scripts/verify-packaged-app.mjs "$APP" "$PROJECT_VERSION"');
  assert.ok(gate > 0);
  assert.ok(gate < source.indexOf('echo "UPDATE ARTIFACTS OK:'));
  assert.match(source, /set -euo pipefail/);
});
