import assert from "node:assert/strict";
import test from "node:test";
import { REPOSITORY, ReleaseResolutionError, normalizeTag, resolveRelease } from "./latest.mjs";

const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA = (n) => String(n).padStart(40, "a");

function release(tag, { draft = false, asset = true } = {}) {
  return {
    tag_name: tag,
    draft,
    prerelease: tag.endsWith("-beta"),
    assets: asset
      ? [
          {
            name: "install.sh",
            state: "uploaded",
            browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/install.sh`,
          },
        ]
      : [],
  };
}

// Serves responses by URL; unknown URLs answer 404.
function github(routes) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof body === "number") return { ok: false, status: body, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, requests };
}

test("stable resolves GitHub's latest release and its commit", async () => {
  const { fetch } = github({
    [`${API}/releases/latest`]: release("release-26.10.3000"),
    [`${API}/commits/release-26.10.3000`]: { sha: SHA(3000) },
  });
  assert.deepEqual(await resolveRelease({ fetch, env: {} }), {
    tag: "release-26.10.3000",
    commit: SHA(3000),
    version: "26.10.3000",
    channel: "stable",
    assetUrl: `https://github.com/${REPOSITORY}/releases/download/release-26.10.3000/install.sh`,
  });
});

test("stable skips upstream tags and releases without the installer", async () => {
  const { fetch } = github({
    [`${API}/releases/latest`]: release("v0.11.0"),
    [`${API}/releases?per_page=100`]: [
      release("release-26.11.100-beta"),
      release("release-26.10.3105", { asset: false }),
      release("release-26.10.3101", { draft: true }),
      release("release-957"),
      release("release-26.9.800"),
      release("release-26.10.900"),
    ],
    [`${API}/commits/release-26.10.900`]: { sha: SHA(900) },
  });
  // Calendar order, not string order: 26.10.900 is newer than 26.9.800.
  assert.equal((await resolveRelease({ fetch, env: {} })).tag, "release-26.10.900");
});

test("beta takes the newest tag of either kind", async () => {
  const { fetch } = github({
    [`${API}/releases?per_page=100`]: [
      release("release-26.10.3000"),
      release("release-26.11.100-beta"),
    ],
    [`${API}/commits/release-26.11.100-beta`]: { sha: SHA(1100) },
  });
  const resolved = await resolveRelease({ fetch, env: { VORTEO_CHANNEL: "beta" } });
  assert.equal(resolved.tag, "release-26.11.100-beta");
  assert.equal(resolved.version, "26.11.100");
  assert.equal(resolved.channel, "beta");
});

test("a pin accepts a tag or a version and must carry the installer", async () => {
  assert.equal(normalizeTag("26.10.3000"), "release-26.10.3000");
  assert.equal(normalizeTag("26.10.3000-beta"), "release-26.10.3000-beta");
  assert.equal(normalizeTag("release-26.10.3000-beta"), "release-26.10.3000-beta");
  for (const other of ["v0.11.0", "940", "release-940", "26.03.3000"]) {
    assert.throws(() => normalizeTag(other), ReleaseResolutionError, other);
  }
  const { fetch } = github({
    [`${API}/releases/tags/release-26.10.3000`]: release("release-26.10.3000", { asset: false }),
  });
  await assert.rejects(resolveRelease({ fetch, env: { VORTEO_VERSION: "26.10.3000" } }), {
    code: "not-found",
  });
});

test("no release yet is not-found, and rate limits explain the token", async () => {
  await assert.rejects(resolveRelease({ fetch: github({}).fetch, env: {} }), { code: "not-found" });
  const { fetch } = github({ [`${API}/releases/latest`]: 403 });
  await assert.rejects(resolveRelease({ fetch, env: {} }), /GITHUB_TOKEN/);
});
