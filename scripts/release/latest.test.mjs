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
    [`${API}/releases/latest`]: release("release-940"),
    [`${API}/commits/release-940`]: { sha: SHA(940) },
  });
  assert.deepEqual(await resolveRelease({ fetch, env: {} }), {
    tag: "release-940",
    commit: SHA(940),
    counter: 940,
    channel: "stable",
    assetUrl: `https://github.com/${REPOSITORY}/releases/download/release-940/install.sh`,
  });
});

test("stable skips upstream tags and releases without the installer", async () => {
  const { fetch } = github({
    [`${API}/releases/latest`]: release("v0.11.0"),
    [`${API}/releases?per_page=100`]: [
      release("release-950-beta"),
      release("release-945", { asset: false }),
      release("release-941", { draft: true }),
      release("release-938"),
    ],
    [`${API}/commits/release-938`]: { sha: SHA(938) },
  });
  assert.equal((await resolveRelease({ fetch, env: {} })).tag, "release-938");
});

test("beta takes the newest tag of either kind", async () => {
  const { fetch } = github({
    [`${API}/releases?per_page=100`]: [release("release-938"), release("release-950-beta")],
    [`${API}/commits/release-950-beta`]: { sha: SHA(950) },
  });
  const resolved = await resolveRelease({ fetch, env: { VORTEO_CHANNEL: "beta" } });
  assert.equal(resolved.tag, "release-950-beta");
  assert.equal(resolved.channel, "beta");
});

test("a pin accepts a tag or a counter and must carry the installer", async () => {
  assert.equal(normalizeTag("940"), "release-940");
  assert.equal(normalizeTag("release-940-beta"), "release-940-beta");
  assert.throws(() => normalizeTag("v0.11.0"), ReleaseResolutionError);
  const { fetch } = github({
    [`${API}/releases/tags/release-940`]: release("release-940", { asset: false }),
  });
  await assert.rejects(resolveRelease({ fetch, env: { VORTEO_VERSION: "940" } }), {
    code: "not-found",
  });
});

test("no release yet is not-found, and rate limits explain the token", async () => {
  await assert.rejects(resolveRelease({ fetch: github({}).fetch, env: {} }), { code: "not-found" });
  const { fetch } = github({ [`${API}/releases/latest`]: 403 });
  await assert.rejects(resolveRelease({ fetch, env: {} }), /GITHUB_TOKEN/);
});
