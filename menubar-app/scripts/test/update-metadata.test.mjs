import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAppcastMetadata,
  parseProjectMetadata,
  validateBuildVersion,
  validateIncreasingBuild,
  validateMarketingVersion,
  validateReleaseVersionSources,
  validateUpdateMetadata,
} from "../lib/update-metadata.mjs";

const validProject = `
CFBundleShortVersionString: "0.8.0"
CFBundleVersion: "8000"
MARKETING_VERSION: "0.8.0"
CURRENT_PROJECT_VERSION: "8000"
`;

function appcast(overrides = {}) {
  const values = {
    version: "8000",
    shortVersion: "0.8.0",
    length: "12345",
    url: "https://github.com/arhxam/whoburnedmore/releases/download/v0.8.0/BurnBar.dmg",
    signature: "signed-update-value",
    minimumSystemVersion: "14.0",
    ...overrides,
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item>
    <sparkle:minimumSystemVersion>${values.minimumSystemVersion}</sparkle:minimumSystemVersion>
    <enclosure url="${values.url}" length="${values.length}"
      sparkle:version="${values.version}"
      sparkle:shortVersionString="${values.shortVersion}"
      sparkle:edSignature="${values.signature}" type="application/octet-stream" />
  </item></channel>
</rss>`;
}

test("accepts semantic marketing versions and positive integer builds", () => {
  assert.equal(validateMarketingVersion("0.8.0"), "0.8.0");
  assert.equal(validateMarketingVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(validateBuildVersion("8000"), 8000n);
});

test("rejects malformed marketing and build versions", () => {
  assert.throws(() => validateMarketingVersion("v0.8"), /semantic version/i);
  assert.throws(() => validateBuildVersion("0"), /positive integer/i);
  assert.throws(() => validateBuildVersion("8.1"), /positive integer/i);
});

test("rejects equal or lower published builds", () => {
  assert.throws(() => validateIncreasingBuild("8000", "8000"), /greater than published build/i);
  assert.throws(() => validateIncreasingBuild("7999", "8000"), /greater than published build/i);
  assert.doesNotThrow(() => validateIncreasingBuild("8001", "8000"));
});

test("parses matching project metadata", () => {
  assert.deepEqual(parseProjectMetadata(validProject), {
    marketingVersion: "0.8.0",
    buildVersion: "8000",
  });
});

test("rejects mismatched project metadata", () => {
  assert.throws(
    () => parseProjectMetadata(validProject.replace('MARKETING_VERSION: "0.8.0"', 'MARKETING_VERSION: "0.8.1"')),
    /marketing version values disagree/i
  );
  assert.throws(
    () => parseProjectMetadata(validProject.replace('CURRENT_PROJECT_VERSION: "8000"', 'CURRENT_PROJECT_VERSION: "8001"')),
    /build version values disagree/i
  );
});

test("parses a signed HTTPS appcast enclosure", () => {
  assert.deepEqual(parseAppcastMetadata(appcast()), {
    marketingVersion: "0.8.0",
    buildVersion: "8000",
    byteLength: 12345,
    enclosureURL: "https://github.com/arhxam/whoburnedmore/releases/download/v0.8.0/BurnBar.dmg",
    edSignature: "signed-update-value",
    minimumSystemVersion: "14.0",
  });
});

test("parses Sparkle 2.9 item-level version elements", () => {
  const currentFormat = appcast()
    .replace(' sparkle:version="8000"', "")
    .replace(' sparkle:shortVersionString="0.8.0"', "")
    .replace(
      "<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>",
      "<sparkle:version>8000</sparkle:version>\n" +
        "    <sparkle:shortVersionString>0.8.0</sparkle:shortVersionString>\n" +
        "    <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>"
    );

  assert.equal(parseAppcastMetadata(currentFormat).buildVersion, "8000");
  assert.equal(parseAppcastMetadata(currentFormat).marketingVersion, "0.8.0");
});

test("rejects missing EdDSA signatures and non-HTTPS update URLs", () => {
  assert.throws(() => parseAppcastMetadata(appcast({ signature: "" })), /EdDSA signature/i);
  assert.throws(() => parseAppcastMetadata(appcast({ url: "http://example.com/BurnBar.dmg" })), /HTTPS/i);
});

test("rejects appcast metadata that disagrees with the release artifact", () => {
  assert.throws(
    () => validateUpdateMetadata({
      project: parseProjectMetadata(validProject),
      appcast: parseAppcastMetadata(appcast({ length: "12344" })),
      expectedByteLength: 12345,
      expectedMinimumSystemVersion: "14.0",
    }),
    /byte length/i
  );
  assert.throws(
    () => validateUpdateMetadata({
      project: parseProjectMetadata(validProject),
      appcast: parseAppcastMetadata(appcast({ shortVersion: "0.8.1" })),
      expectedByteLength: 12345,
      expectedMinimumSystemVersion: "14.0",
    }),
    /marketing version/i
  );
});

test("requires every distributed version string to match the project version", () => {
  const matching = {
    infoPlist: "<key>CFBundleShortVersionString</key><string>0.8.0</string>",
    webPage: 'const APP_VERSION = "0.8.0";',
    campaign: 'export const BURNBAR_VERSION = "0.8.0";',
    wbmClient: 'req.setValue("burnbar/0.8.0", forHTTPHeaderField: "User-Agent")',
    deviceFlow: 'req.setValue("burnbar/0.8.0", forHTTPHeaderField: "User-Agent")',
    sidecarMain: 'const VERSION = "0.8.0";',
    sidecarSync: 'const SIDECAR_CLI_VERSION = "burnbar-0.8.0";',
  };
  assert.doesNotThrow(() => validateReleaseVersionSources("0.8.0", matching));
  assert.throws(
    () => validateReleaseVersionSources("0.8.0", { ...matching, sidecarMain: 'const VERSION = "0.7.3";' }),
    /sidecar main.*0\.8\.0/i
  );
  assert.throws(
    () => validateReleaseVersionSources("0.8.0", { ...matching, campaign: 'export const BURNBAR_VERSION = "0.7.3";' }),
    /campaign.*0\.8\.0/i
  );
  assert.throws(
    () => validateReleaseVersionSources("0.8.0", { ...matching, deviceFlow: 'burnbar/0.2.0' }),
    /DeviceFlow.*0\.8\.0/i
  );
});
