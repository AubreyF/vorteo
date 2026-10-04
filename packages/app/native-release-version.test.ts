import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("keeps native build numbers increasing when the custom suffix changes", () => {
    const previous = getNativeReleaseVersion("0.9.0-beta.2.vorton.40");
    const next = getNativeReleaseVersion("0.9.0-beta.2.vorteo.41");
    expect(next.androidVersionCode).toBe(previous.androidVersionCode + 1);
    expect(Number(next.iosBuildNumber)).toBe(Number(previous.iosBuildNumber) + 1);
    expect(getNativeReleaseVersion("0.9.0-vorteo.41")).toEqual(
      getNativeReleaseVersion("0.9.0-vorton.41"),
    );
    expect(() => getNativeReleaseVersion("0.9.0-beta.2.vorteo.1000")).toThrow("out of range");
  });

  it("orders Vorton beta revisions, later betas, stable promotion and the next base", () => {
    const versions = [
      "0.8.999-vorton.99999",
      "0.9.0-beta.1.vorton.1",
      "0.9.0-beta.1.vorton.999",
      "0.9.0-beta.2.vorton.1",
      "0.9.0-beta.98.vorton.999",
      "0.9.0-vorton.1",
      "0.9.0-vorton.999",
      "0.9.1-beta.1.vorton.1",
    ];
    const builds = versions.map((version) => getNativeReleaseVersion(version));
    for (let i = 1; i < builds.length; i++) {
      expect(builds[i].androidVersionCode).toBeGreaterThan(builds[i - 1].androidVersionCode);
      expect(Number(builds[i].iosBuildNumber)).toBeGreaterThan(
        Number(builds[i - 1].iosBuildNumber),
      );
    }
    expect(getNativeReleaseVersion("0.9.0-beta.2.vorton.1")).toEqual({
      appVersion: "0.9.0",
      androidVersionCode: 900002001,
      iosBuildNumber: "900002001",
    });
  });

  it("rejects exhausted Vorton revision and beta slots without collisions", () => {
    for (const version of [
      "0.9.0-beta.2.vorton.0",
      "0.9.0-beta.2.vorton.1000",
      "0.9.0-vorton.1000",
    ]) {
      expect(() => getNativeReleaseVersion(version)).toThrow("out of range");
    }
    expect(() => getNativeReleaseVersion("0.9.0-beta.99.vorton.1")).toThrow("between 1 and 98");
    expect(() => getNativeReleaseVersion("0.8.0-beta.1.vorton.1")).toThrow("from 0.9.0");
    expect(() => getNativeReleaseVersion("0.9.0-vorton.1.vorton.1")).toThrow("unsupported");
  });

  it("orders Vorton builds within and across upstream bases", () => {
    const first = getNativeReleaseVersion("0.7.2-vorton.9999");
    const next = getNativeReleaseVersion("0.7.2-vorton.10000");
    const upstream = getNativeReleaseVersion("0.7.3-vorton.1");
    expect(first.appVersion).toBe("0.7.2");
    expect(next.androidVersionCode).toBeGreaterThan(first.androidVersionCode);
    expect(upstream.androidVersionCode).toBeGreaterThan(next.androidVersionCode);
    expect(Number(next.iosBuildNumber)).toBeGreaterThan(Number(first.iosBuildNumber));
    expect(() => getNativeReleaseVersion("0.7.2-vorton.100000")).toThrow("out of range");
  });

  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});
