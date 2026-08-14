#!/usr/bin/env node
import fs from "node:fs";

import {
  parseAppcastMetadata,
  parseProjectMetadata,
  validateIncreasingBuild,
  validateReleaseVersionSources,
  validateUpdateMetadata,
} from "./lib/update-metadata.mjs";

function argumentsByName(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}`);
    }
    result.set(key.slice(2), value);
  }
  return result;
}

try {
  const args = argumentsByName(process.argv.slice(2));
  const projectPath = args.get("project");
  const appcastPath = args.get("appcast");
  const byteLength = args.get("byte-length");
  const minimumSystemVersion = args.get("minimum-system-version") ?? "14.0";
  if (!projectPath || !appcastPath || !byteLength) {
    throw new Error(
      "usage: verify-update-metadata.mjs --project <project.yml> --appcast <appcast.xml> --byte-length <bytes> [--published-appcast <appcast.xml>] [--minimum-system-version <version>] [--signature-only true]"
    );
  }

  const project = parseProjectMetadata(fs.readFileSync(projectPath, "utf8"));
  validateReleaseVersionSources(project.marketingVersion, {
    infoPlist: fs.readFileSync("Info.plist", "utf8"),
    webPage: fs.readFileSync("../web/src/app/app/page.tsx", "utf8"),
    wbmClient: fs.readFileSync("Sources/BurnBar/WbmClient.swift", "utf8"),
    sidecarMain: fs.readFileSync("sidecar/src/main.ts", "utf8"),
    sidecarSync: fs.readFileSync("sidecar/src/sync.ts", "utf8"),
  });
  const appcast = parseAppcastMetadata(fs.readFileSync(appcastPath, "utf8"));
  validateUpdateMetadata({
    project,
    appcast,
    expectedByteLength: Number(byteLength),
    expectedMinimumSystemVersion: minimumSystemVersion,
  });

  const expectedURL =
    `https://github.com/arhxam/whoburnedmore/releases/download/v${project.marketingVersion}/BurnBar.dmg`;
  if (appcast.enclosureURL !== expectedURL) {
    throw new Error(`Appcast enclosure URL ${appcast.enclosureURL} does not match ${expectedURL}`);
  }

  const publishedPath = args.get("published-appcast");
  if (publishedPath) {
    const published = parseAppcastMetadata(fs.readFileSync(publishedPath, "utf8"));
    validateIncreasingBuild(project.buildVersion, published.buildVersion);
  }

  if (args.get("signature-only") === "true") {
    process.stdout.write(appcast.edSignature);
  } else {
    console.log(
      `UPDATE METADATA OK: BurnBar ${project.marketingVersion} (${project.buildVersion}), ${appcast.byteLength} bytes`
    );
  }
} catch (error) {
  console.error(`UPDATE METADATA FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
