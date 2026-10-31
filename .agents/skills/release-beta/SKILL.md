---
name: release-beta
description: Cut a beta release of Vorteo. Use when the user says "release beta", "cut a beta", "ship a beta", "beta release", or "/release-beta".
user-invocable: true
---

# Release beta

Follow [Vorteo releases](../../../docs/release.md#vorteo-releases). Only Vorteo :: Builds tags; other threads hand the request to Builds.

1. Prepare the version: `node scripts/vorteo-release.mjs prepare --channel beta`, then commit it with a `## <version> - YYYY-MM-DD` changelog entry, deliver it to the beta release branch (`main` until the planned `beta` branch exists) and install it.
2. Confirm the commit this installation installed is that preparation, is on the release branch and passed its acceptance checks.
3. Run `node scripts/vorteo-release.mjs tag --channel beta --commit <installed commit> --dry-run`, then again without `--dry-run`. Add `--release` to publish the GitHub prerelease.
4. Report the tag, commit and version, and verify them with `node scripts/vorteo-release.mjs list --channel beta`.

Never use upstream `release:*` scripts or create `v*` tags. Never move or reuse a tag; fix forward.
