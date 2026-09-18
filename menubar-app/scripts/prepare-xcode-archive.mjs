#!/usr/bin/env node
// Package the fully assembled, signed release app for Xcode Organizer. This
// neither signs code nor accesses signing/notarization credentials.
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateBuildVersion, validateMarketingVersion } from "./lib/update-metadata.mjs";

const execute = promisify(execFile);
const EXPECTED_ID = "com.whoburnedmore.burnbar";
const EXPECTED_TEAM = "84MFPMUB97";
const defaultApp = fileURLToPath(new URL("../dist/BurnBar.app", import.meta.url));

export function parseArguments(args) {
  const options = { app: defaultApp };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--app", "--output"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("Usage: prepare-xcode-archive.mjs [--app dist/BurnBar.app] --output build/Name.xcarchive");
    }
    const field = key.slice(2);
    if (field === "output" && options.output) throw new Error("Duplicate --output");
    options[field] = args[index + 1];
  }
  if (!options.output) throw new Error("An explicit --output archive path is required");
  return options;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

export function archiveMetadata(info, signature, appName, now = new Date()) {
  if (info.CFBundleIdentifier !== EXPECTED_ID || signature.identifier !== EXPECTED_ID) {
    throw new Error(`Expected app bundle identifier ${EXPECTED_ID}`);
  }
  if (signature.team !== EXPECTED_TEAM || !signature.identity?.startsWith("Developer ID Application:") ||
      !signature.identity.endsWith(`(${EXPECTED_TEAM})`)) {
    throw new Error(`Expected Developer ID Application signature for team ${EXPECTED_TEAM}`);
  }
  validateMarketingVersion(info.CFBundleShortVersionString);
  validateBuildVersion(info.CFBundleVersion);
  if (info.CFBundlePackageType !== "APPL" || !info.CFBundleSupportedPlatforms?.includes("MacOSX")) {
    throw new Error("Expected a macOS application bundle");
  }
  if (basename(appName) !== appName || !appName.endsWith(".app")) throw new Error("Invalid archive application name");
  const properties = {
    ApplicationPath: `Applications/${appName}`,
    CFBundleIdentifier: info.CFBundleIdentifier,
    CFBundleShortVersionString: info.CFBundleShortVersionString,
    CFBundleVersion: info.CFBundleVersion,
    SigningIdentity: signature.identity,
    Team: signature.team,
  };
  const rows = Object.entries(properties).map(([key, value]) =>
    `    <key>${key}</key><string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>ApplicationProperties</key><dict>
${rows}
  </dict>
  <key>ArchiveVersion</key><integer>2</integer>
  <key>CreationDate</key><date>${now.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>
  <key>Name</key><string>${xml(info.CFBundleDisplayName || info.CFBundleName || "whoburnedmore")}</string>
  <key>SchemeName</key><string>BurnBar</string>
</dict></plist>\n`;
}

async function command(file, args) {
  return execute(file, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

async function inspectApp(app, run) {
  await run("/usr/bin/codesign", ["--verify", "--strict", "--deep", app]);
  const details = await run("/usr/bin/codesign", ["--display", "--verbose=4", app]);
  const signatureText = `${details.stderr || ""}\n${details.stdout || ""}`;
  const signature = {
    identifier: signatureText.match(/^Identifier=(.+)$/m)?.[1],
    team: signatureText.match(/^TeamIdentifier=(.+)$/m)?.[1],
    identity: signatureText.match(/^Authority=(.+)$/m)?.[1],
  };
  const plist = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")]);
  const info = JSON.parse(plist.stdout);
  // Generate metadata here too so invalid identities/versions fail before any
  // output is created. The archived copy is independently checked below.
  archiveMetadata(info, signature, basename(app));
  const executable = info.CFBundleExecutable;
  if (typeof executable !== "string" || !executable || basename(executable) !== executable) {
    throw new Error("Invalid application executable name");
  }
  for (const path of [
    `Contents/MacOS/${executable}`, "Contents/Resources/burnbar-sidecar", "Contents/Resources/ccusage",
  ]) {
    const metadata = await stat(join(app, path));
    if (!metadata.isFile() || !(metadata.mode & 0o111)) throw new Error(`Missing executable release component: ${path}`);
  }
  for (const path of ["Contents/Frameworks/BurnBarCore.framework", "Contents/Frameworks/Sparkle.framework"]) {
    if (!(await stat(join(app, path))).isDirectory()) throw new Error(`Missing release framework: ${path}`);
  }
  return { info, signature };
}

export async function prepareArchive({ app = defaultApp, output }, { run = command, now = new Date() } = {}) {
  if (!output) throw new Error("An explicit --output archive path is required");
  const source = await realpath(resolve(app));
  if (!source.endsWith(".app") || !(await stat(source)).isDirectory()) throw new Error("Source must be an .app directory");
  const requested = resolve(output);
  if (!requested.endsWith(".xcarchive")) throw new Error("Output must end in .xcarchive");
  // Parent must already exist; resolving it closes the symlink-alias case where
  // a harmless-looking build path actually points inside the source bundle.
  const destination = join(await realpath(dirname(requested)), basename(requested));
  const inside = relative(source, destination);
  if (!inside || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))) {
    throw new Error("Archive output must not be inside the source app");
  }
  try {
    await lstat(destination);
    throw new Error(`Refusing to overwrite existing output: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const initial = await inspectApp(source, run);
  // Exclusive mkdir prevents races from overwriting another release archive.
  await mkdir(destination);
  try {
    const applications = join(destination, "Products/Applications");
    await mkdir(applications, { recursive: true });
    const archivedApp = join(applications, basename(source));
    // ditto preserves framework symlinks, modes, resource forks and attributes.
    await run("/usr/bin/ditto", [source, archivedApp]);
    const copied = await inspectApp(archivedApp, run);
    if (JSON.stringify(copied) !== JSON.stringify(initial)) throw new Error("App metadata changed while packaging");
    await writeFile(join(destination, "Info.plist"), archiveMetadata(copied.info, copied.signature, basename(source), now), { flag: "wx" });
    await run("/usr/bin/plutil", ["-lint", join(destination, "Info.plist")]);
    return { archive: destination, app: archivedApp, version: copied.info.CFBundleShortVersionString, build: copied.info.CFBundleVersion };
  } catch (error) {
    // This directory was exclusively created above, so cleanup can only remove
    // our own incomplete output; the signed source app is never modified.
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await prepareArchive(parseArguments(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`Archive preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
