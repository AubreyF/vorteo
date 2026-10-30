const versionPattern =
  /^(\d+)\.(\d+)\.(\d+)(?:-(beta|vorteo|vorton)\.(\d+)(?:\.(?:vorteo|vorton)\.(\d+))?)?$/;
const stableIosBuildSlot = 999;
const FDROID_ABI_VERSION_CODE_SUFFIXES = {
  "armeabi-v7a": 1,
  "arm64-v8a": 2,
  x86: 3,
  x86_64: 4,
};

// Vorteo calendar versions, YY.M.DDNN (scripts/vorteo-version.mjs). The year floor keeps
// upstream versions such as 0.1.105 on the semver path.
const calendarPattern = /^([1-9]\d+)\.([1-9]|1[0-2])\.([1-9]\d{2,3})$/;
const firstCalendarYear = 26;
// Above every legacy Vorteo build (0.11.0 reached 1_100_099_999), so native upgrades from a
// counter version to a calendar version keep increasing.
const calendarBuildBase = 1_200_000_000;

function getCalendarReleaseVersion(version) {
  const match = calendarPattern.exec(version);
  if (!match || Number(match[1]) < firstCalendarYear) return null;
  const [year, month, patch] = match.slice(1).map(Number);
  const day = Math.floor(patch / 100);
  if (day < 1 || day > 31) {
    throw new Error(`Vorteo calendar version encodes an invalid day: ${version}`);
  }
  const build =
    calendarBuildBase + (year - firstCalendarYear) * 10_000_000 + month * 100_000 + patch;
  if (build > 2_100_000_000) {
    throw new Error(`Vorteo native build number is out of range: ${version}`);
  }
  return { appVersion: version, androidVersionCode: build, iosBuildNumber: String(build) };
}

function getNativeReleaseVersion(version) {
  const calendar = getCalendarReleaseVersion(version);
  if (calendar) return calendar;
  const match = versionPattern.exec(version);
  if (!match) {
    throw new Error(`Cannot derive native release version from unsupported version: ${version}`);
  }

  const [, majorText, minorText, patchText, channel, counterText, betaVortonCounter] = match;
  if (betaVortonCounter && channel !== "beta") {
    throw new Error(`Cannot derive native release version from unsupported version: ${version}`);
  }
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const betaNumber = channel === "beta" ? Number(counterText) : null;

  if (minor > 999 || patch > 999) {
    throw new Error(`Cannot derive collision-free native version from: ${version}`);
  }
  if (betaNumber !== null && (betaNumber < 1 || betaNumber >= stableIosBuildSlot)) {
    throw new Error(`iOS beta number must be between 1 and 998: ${version}`);
  }

  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 0 ||
    versionCode * 10 + 9 > 2_100_000_000
  ) {
    throw new Error(`Derived Android versionCode is out of range: ${versionCode}`);
  }

  const iosBuildSlot = betaNumber ?? stableIosBuildSlot;
  const iosBuildNumber = versionCode * 1_000 + iosBuildSlot;
  if (!Number.isSafeInteger(iosBuildNumber)) {
    throw new Error(`Derived iOS buildNumber is out of range: ${iosBuildNumber}`);
  }

  // Vorteo uses a separate native distribution. Reserve five digits per upstream base.
  if (channel === "vorteo" || channel === "vorton" || betaVortonCounter !== undefined) {
    const build = getVortonBuildNumber(
      version,
      versionCode,
      Number(betaVortonCounter ?? counterText),
      betaNumber,
    );
    return {
      appVersion: `${major}.${minor}.${patch}`,
      androidVersionCode: build,
      iosBuildNumber: String(build),
    };
  }

  return {
    appVersion: `${major}.${minor}.${patch}`,
    androidVersionCode: versionCode,
    iosBuildNumber: String(iosBuildNumber),
  };
}

function getVortonBuildNumber(version, versionCode, counter, betaNumber) {
  // Preserve published numbers before 0.9.0; newer bases reserve ordered beta slots.
  const partitioned = versionCode >= 9_000;
  const slot = betaNumber ?? 99;
  if (betaNumber !== null && (!partitioned || slot < 1 || slot > 98)) {
    throw new Error(`Vorteo beta native slot must be between 1 and 98 from 0.9.0: ${version}`);
  }
  const build = versionCode * 100_000 + (partitioned ? slot * 1_000 : 0) + counter;
  if (
    !Number.isSafeInteger(counter) ||
    counter < 1 ||
    counter >= (partitioned ? 1_000 : 100_000) ||
    build > 2_100_000_000
  ) {
    throw new Error(`Vorteo native build number is out of range: ${version}`);
  }
  return build;
}

function getFdroidVersionCodes(version) {
  const { androidVersionCode } = getNativeReleaseVersion(version);
  if (androidVersionCode * 10 + 9 > 2_100_000_000) {
    throw new Error(`Derived F-Droid versionCode is out of range: ${version}`);
  }
  return Object.entries(FDROID_ABI_VERSION_CODE_SUFFIXES).map(([abi, suffix]) => ({
    abi,
    versionCode: androidVersionCode * 10 + suffix,
  }));
}

module.exports = {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
};
