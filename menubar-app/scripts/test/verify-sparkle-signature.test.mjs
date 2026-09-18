import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifySparkleSignature } from "../verify-sparkle-signature.mjs";

// RFC 8032 section 7.1, test 1: public test vector, no private key involved.
const publicKey = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex").toString("base64");
const signature = Buffer.from("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", "hex").toString("base64");

test("verifies a standard Ed25519 public test vector", () => {
  assert.equal(verifySparkleSignature(Buffer.alloc(0), signature, publicKey), true);
});

test("rejects changed archive bytes, signature, and public key", () => {
  assert.throws(() => verifySparkleSignature(Buffer.from("tampered"), signature, publicKey), /does not match/);
  const changedSignature = Buffer.from(signature, "base64");
  changedSignature[0] ^= 1;
  assert.throws(() => verifySparkleSignature(Buffer.alloc(0), changedSignature.toString("base64"), publicKey), /does not match/);
  const wrongKey = Buffer.from("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "hex").toString("base64");
  assert.throws(() => verifySparkleSignature(Buffer.alloc(0), signature, wrongKey), /does not match/);
});

test("rejects malformed, wrong-length and noncanonical base64 metadata", () => {
  for (const invalid of ["", "not base64", publicKey.slice(0, -1), `${publicKey}\n`, signature]) {
    assert.throws(() => verifySparkleSignature(Buffer.alloc(0), signature, invalid), /Invalid Sparkle public key/);
  }
  for (const invalid of ["", publicKey, `${signature}!`]) {
    assert.throws(() => verifySparkleSignature(Buffer.alloc(0), invalid, publicKey), /Invalid Sparkle signature/);
  }
});

test("CLI returns success only for unchanged signed bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wbm-public-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "archive.dmg");
  const script = fileURLToPath(new URL("../verify-sparkle-signature.mjs", import.meta.url));
  await writeFile(file, "");
  let result = spawnSync(process.execPath, [script, file, signature, publicKey], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SIGNATURE OK/);
  await writeFile(file, "changed");
  result = spawnSync(process.execPath, [script, file, signature, publicKey], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match/);
});

test("release gate retains configured-key equality and uses only public verification", async () => {
  const source = await readFile(new URL("../verify-update-artifacts.sh", import.meta.url), "utf8");
  assert.ok(source.includes('[[ "$BUNDLED_PUBLIC_KEY" == "$SIGNING_PUBLIC_KEY" ]]'));
  assert.ok(source.includes('"$BIN/generate_keys" --account "$ACCOUNT" -p'));
  assert.ok(source.includes('node scripts/verify-sparkle-signature.mjs "$DMG" "$SIGNATURE" "$BUNDLED_PUBLIC_KEY"'));
  assert.ok(!source.includes("BURNBAR_SPARKLE_PRIVATE_KEY"));
  assert.ok(!source.includes('"$BIN/sign_update"'));
});
