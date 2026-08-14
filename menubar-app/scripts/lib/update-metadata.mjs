const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateMarketingVersion(value) {
  if (typeof value !== "string" || !SEMANTIC_VERSION.test(value)) {
    throw new Error(`Marketing version must be a semantic version, received: ${String(value)}`);
  }
  return value;
}

export function validateBuildVersion(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`Build version must be a positive integer, received: ${String(value)}`);
  }
  return BigInt(value);
}

export function validateIncreasingBuild(proposedBuild, publishedBuild) {
  const proposed = validateBuildVersion(proposedBuild);
  const published = validateBuildVersion(publishedBuild);
  if (proposed <= published) {
    throw new Error(
      `Proposed build ${proposedBuild} must be greater than published build ${publishedBuild}`
    );
  }
}

export function validateReleaseVersionSources(marketingVersion, sources) {
  validateMarketingVersion(marketingVersion);
  const escaped = marketingVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const checks = [
    ["Info.plist", sources.infoPlist, new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${escaped}</string>`)],
    ["web page", sources.webPage, new RegExp(`const APP_VERSION = ["']${escaped}["']`)],
    ["WbmClient", sources.wbmClient, new RegExp(`burnbar/${escaped}`)],
    ["sidecar main", sources.sidecarMain, new RegExp(`const VERSION = ["']${escaped}["']`)],
    ["sidecar sync", sources.sidecarSync, new RegExp(`burnbar-${escaped}`)],
  ];
  for (const [label, source, pattern] of checks) {
    if (typeof source !== "string" || !pattern.test(source)) {
      throw new Error(`${label} must advertise release version ${marketingVersion}`);
    }
  }
}

function valuesForYAMLKey(source, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escapedKey}:\\s*["']?([^"'#\\s]+)`, "gm");
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function requiredSingleValue(source, key) {
  const values = valuesForYAMLKey(source, key);
  if (values.length !== 1) {
    throw new Error(`Expected exactly one ${key} value in project.yml; found ${values.length}`);
  }
  return values[0];
}

export function parseProjectMetadata(source) {
  const bundleMarketing = requiredSingleValue(source, "CFBundleShortVersionString");
  const buildMarketing = requiredSingleValue(source, "MARKETING_VERSION");
  if (bundleMarketing !== buildMarketing) {
    throw new Error(
      `Project marketing version values disagree: ${bundleMarketing} != ${buildMarketing}`
    );
  }

  const bundleBuild = requiredSingleValue(source, "CFBundleVersion");
  const currentBuild = requiredSingleValue(source, "CURRENT_PROJECT_VERSION");
  if (bundleBuild !== currentBuild) {
    throw new Error(`Project build version values disagree: ${bundleBuild} != ${currentBuild}`);
  }

  validateMarketingVersion(bundleMarketing);
  validateBuildVersion(bundleBuild);
  return { marketingVersion: bundleMarketing, buildVersion: bundleBuild };
}

function optionalAttribute(element, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = element.match(new RegExp(`(?:^|\\s)${escapedName}="([^"]*)"`));
  return match?.[1]?.trim() || undefined;
}

function requiredAttribute(element, name, description) {
  const value = optionalAttribute(element, name);
  if (!value) {
    throw new Error(`Appcast enclosure is missing ${description}`);
  }
  return value;
}

function optionalElementText(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`<${escapedName}>\\s*([^<]+?)\\s*</${escapedName}>`))?.[1]?.trim();
}

export function parseAppcastMetadata(source) {
  const enclosure = source.match(/<enclosure\b[\s\S]*?\/>/)?.[0];
  if (!enclosure) {
    throw new Error("Appcast is missing an enclosure");
  }

  const marketingVersion = optionalAttribute(enclosure, "sparkle:shortVersionString")
    ?? optionalElementText(source, "sparkle:shortVersionString");
  const buildVersion = optionalAttribute(enclosure, "sparkle:version")
    ?? optionalElementText(source, "sparkle:version");
  if (!marketingVersion) throw new Error("Appcast is missing a marketing version");
  if (!buildVersion) throw new Error("Appcast is missing a build version");
  const rawLength = requiredAttribute(enclosure, "length", "a byte length");
  const enclosureURL = requiredAttribute(enclosure, "url", "an update URL");
  const edSignature = requiredAttribute(
    enclosure,
    "sparkle:edSignature",
    "an EdDSA signature"
  );

  validateMarketingVersion(marketingVersion);
  validateBuildVersion(buildVersion);
  if (!/^\d+$/.test(rawLength) || Number(rawLength) <= 0) {
    throw new Error(`Appcast byte length must be a positive integer, received: ${rawLength}`);
  }

  let parsedURL;
  try {
    parsedURL = new URL(enclosureURL);
  } catch {
    throw new Error(`Appcast enclosure URL is invalid: ${enclosureURL}`);
  }
  if (parsedURL.protocol !== "https:") {
    throw new Error(`Appcast enclosure URL must use HTTPS: ${enclosureURL}`);
  }

  const minimumSystemVersion = optionalElementText(source, "sparkle:minimumSystemVersion");
  if (!minimumSystemVersion) {
    throw new Error("Appcast is missing sparkle:minimumSystemVersion");
  }

  return {
    marketingVersion,
    buildVersion,
    byteLength: Number(rawLength),
    enclosureURL,
    edSignature,
    minimumSystemVersion,
  };
}

export function validateUpdateMetadata({
  project,
  appcast,
  expectedByteLength,
  expectedMinimumSystemVersion,
}) {
  if (project.marketingVersion !== appcast.marketingVersion) {
    throw new Error(
      `Appcast marketing version ${appcast.marketingVersion} does not match project ${project.marketingVersion}`
    );
  }
  if (project.buildVersion !== appcast.buildVersion) {
    throw new Error(
      `Appcast build version ${appcast.buildVersion} does not match project ${project.buildVersion}`
    );
  }
  if (appcast.byteLength !== expectedByteLength) {
    throw new Error(
      `Appcast byte length ${appcast.byteLength} does not match DMG byte length ${expectedByteLength}`
    );
  }
  if (appcast.minimumSystemVersion !== expectedMinimumSystemVersion) {
    throw new Error(
      `Appcast minimum system version ${appcast.minimumSystemVersion} does not match ${expectedMinimumSystemVersion}`
    );
  }
  return { project, appcast };
}
