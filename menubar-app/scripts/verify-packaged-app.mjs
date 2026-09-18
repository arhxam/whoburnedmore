#!/usr/bin/env node
// Validate package identity before running any executable from a release DMG.
import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateMarketingVersion } from "./lib/update-metadata.mjs";

const execute = promisify(execFile);
const TEAM = "84MFPMUB97";
// Require Apple's Developer ID certificate chain, the exact team, and the
// expected code identifier. A valid ad-hoc or other developer's signature is
// insufficient authorization to execute a downloaded release helper.
export function releaseRequirement(identifier) {
  if (!["com.whoburnedmore.burnbar", "burnbar-sidecar"].includes(identifier)) {
    throw new Error("Unexpected release code identifier");
  }
  // codesign treats a requirement argument as a filename unless prefixed '='.
  return `=anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${TEAM}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
}

async function command(file, args, options = {}) {
  return execute(file, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024, ...options });
}

export async function verifyPackagedApp(appPath, expectedVersion, { run = command } = {}) {
  validateMarketingVersion(expectedVersion);
  const app = resolve(appPath);
  const resources = join(app, "Contents/Resources");
  const carrier = (await readdir(resources)).find((name) => /\.dmg$/i.test(name));
  if (carrier) throw new Error(`Refusing notarization carrier: embedded disk image ${carrier}`);
  const sidecar = join(resources, "burnbar-sidecar");
  const metadata = await lstat(sidecar);
  if (!metadata.isFile() || !(metadata.mode & 0o111)) {
    throw new Error("Packaged sidecar must be a regular executable file");
  }
  await run("/usr/bin/codesign", [
    "--verify", "--strict", "--deep", "--verbose=4", "--test-requirement",
    releaseRequirement("com.whoburnedmore.burnbar"), app,
  ]);
  await run("/usr/bin/codesign", [
    "--verify", "--strict", "--verbose=4", "--test-requirement",
    releaseRequirement("burnbar-sidecar"), sidecar,
  ]);
  // Only the verified, sealed helper executes, bounded in time and output.
  const result = await run(sidecar, ["version"], { timeout: 10_000, maxBuffer: 1024 });
  const actualVersion = result.stdout.trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`Packaged sidecar version ${JSON.stringify(actualVersion)} != project ${expectedVersion}`);
  }
  return actualVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: verify-packaged-app.mjs <BurnBar.app> <project-version>");
    console.log(`PACKAGED APP OK: ${await verifyPackagedApp(process.argv[2], process.argv[3])}`);
  } catch (error) {
    console.error(`Packaged app verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
