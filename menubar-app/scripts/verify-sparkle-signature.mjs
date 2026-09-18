#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function decodeBase64(value, byteLength, description) {
  if (typeof value !== "string") throw new Error(`Invalid ${description}`);
  const decoded = Buffer.from(value, "base64");
  // Buffer.from tolerates garbage and missing padding. Release metadata must
  // contain the canonical Sparkle base64 representation with its exact length.
  if (decoded.length !== byteLength || decoded.toString("base64") !== value) {
    throw new Error(`Invalid ${description}: expected ${byteLength} bytes of canonical base64`);
  }
  return decoded;
}

/** Sparkle's archive signatures are standard Ed25519 over the complete raw
 * archive bytes, with a 32-byte public key and 64-byte signature. This matches
 * Sparkle 2.9.2's Autoupdate/SUSignatureVerifier.m and sign_update/main.swift.
 * Do not prehash the archive or use Ed25519ph. No private key is needed. */
export function verifySparkleSignature(data, base64Signature, base64PublicKey) {
  const signature = decodeBase64(base64Signature, 64, "Sparkle signature");
  const publicBytes = decodeBase64(base64PublicKey, 32, "Sparkle public key");
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicBytes.toString("base64url") },
    format: "jwk",
  });
  if (!verify(null, data, publicKey, signature)) {
    throw new Error("Sparkle Ed25519 signature does not match the archive and public key");
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) {
      throw new Error("Usage: verify-sparkle-signature.mjs <archive> <base64-signature> <base64-public-key>");
    }
    verifySparkleSignature(await readFile(process.argv[2]), process.argv[3], process.argv[4]);
    console.log("SPARKLE SIGNATURE OK (public-key verification)");
  } catch (error) {
    console.error(`Sparkle signature verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
