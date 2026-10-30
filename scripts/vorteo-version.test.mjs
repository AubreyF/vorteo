import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarDay,
  compareTags,
  compareVersions,
  formatVersion,
  isVersion,
  legacyCounter,
  nextVersion,
  parseTag,
  parseVersion,
  tagName,
} from "./vorteo-version.mjs";

test("calendar versions parse as YY.M.DDNN without leading zeros", () => {
  assert.deepEqual(parseVersion("26.10.3001"), {
    version: "26.10.3001",
    year: 26,
    month: 10,
    day: 30,
    build: 1,
  });
  assert.equal(parseVersion("27.1.100").day, 1);
  assert.equal(formatVersion({ year: 26, month: 3, day: 1, build: 5 }), "26.3.105");
  assert.equal(formatVersion({ year: 26, month: 3, day: 15, build: 0 }), "26.3.1500");
  for (const invalid of [
    "26.03.3001",
    "026.10.3001",
    "26.10.03001",
    "26.13.100",
    "26.10.3200",
    "26.10.99",
    "25.12.100",
    "256.1.100",
    "26.10.3001-beta",
    "v26.10.3001",
    "0.11.0-beta.3.vorteo.957",
  ]) {
    assert.equal(isVersion(invalid), false, invalid);
  }
  assert.throws(() => formatVersion({ year: 26, month: 3, day: 1, build: 100 }), /0 through 99/);
});

test("legacy counter versions sort below every calendar version; next versions follow the day", () => {
  assert.equal(legacyCounter("0.11.0-beta.3.vorteo.957"), 957);
  assert.equal(legacyCounter("0.9.0-vorton.40"), 40);
  assert.equal(legacyCounter("26.10.3001"), null);
  assert.equal(compareVersions("0.11.0-beta.3.vorteo.957", "26.10.3000"), -1);
  assert.equal(compareVersions("26.10.3000", "0.11.0-beta.3.vorteo.99999"), 1);
  assert.equal(compareVersions("0.11.0-beta.3.vorteo.957", "0.11.0-beta.3.vorteo.956"), 1);
  assert.equal(compareVersions("26.10.3001", "26.10.3000"), 1);
  assert.equal(compareVersions("26.11.100", "26.10.3100"), 1);
  assert.equal(compareVersions("27.1.100", "26.12.3199"), 1);
  assert.equal(compareVersions("26.10.3001", "26.10.3001"), 0);
  assert.throws(() => compareVersions("0.11.0", "26.10.3000"), /year 0/);
  const today = { year: 26, month: 10, day: 30 };
  assert.equal(nextVersion([], today), "26.10.3000");
  assert.equal(nextVersion(["0.11.0-beta.3.vorteo.957", "26.10.2905"], today), "26.10.3000");
  // Builds are shared by both channels, so a beta and a stable release never collide.
  assert.equal(nextVersion(["26.10.3000", "26.10.3004", "26.10.3001"], today), "26.10.3005");
  assert.throws(() => nextVersion(["26.10.3100"], today), /later than today/);
  assert.throws(() => nextVersion(["26.10.3099"], today), /100 releases/);
  assert.deepEqual(calendarDay(new Date(2026, 0, 5, 23, 59)), { year: 26, month: 1, day: 5 });
});

test("tags carry the version and the channel", () => {
  assert.equal(tagName("stable", "26.10.3001"), "release-26.10.3001");
  assert.equal(tagName("beta", "26.10.3001"), "release-26.10.3001-beta");
  assert.throws(() => tagName("nightly", "26.10.3001"), /beta or stable/);
  assert.throws(() => tagName("beta", "0.11.0-beta.3.vorteo.957"), /not a Vorteo version/);
  assert.deepEqual(parseTag("release-26.10.3001-beta"), {
    name: "release-26.10.3001-beta",
    version: "26.10.3001",
    channel: "beta",
  });
  for (const other of ["release-957", "release-957-beta", "v26.10.3001", "release-26.10.3001-rc"]) {
    assert.equal(parseTag(other), null, other);
  }
  const sorted = ["release-26.10.3000", "release-26.10.3001-beta", "release-26.10.3001"]
    .map(parseTag)
    .sort(compareTags)
    .map((tag) => tag.name);
  assert.deepEqual(sorted, ["release-26.10.3001", "release-26.10.3001-beta", "release-26.10.3000"]);
});
