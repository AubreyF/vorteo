const versionPattern =
  /^(\d+)\.(\d+)\.(\d+)(?:-(beta|vorteo|vorton)\.(\d+)(?:\.(?:vorteo|vorton)\.(\d+))?)?$/;
const stableIosBuildSlot = 999;
const FDROID_ABI_VERSION_CODE_SUFFIXES = {
  "armeabi-v7a": 1,
  "arm64-v8a": 2,
  x86: 3,
  x86_64: 4,
};

function getNativeReleaseVersion(version) {
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
