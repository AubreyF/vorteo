---
name: release-beta
description: Cut a beta release of Vorteo. Use when the user says "release beta", "cut a beta", "ship a beta", "beta release", or "/release-beta".
user-invocable: true
---

# Release beta

Follow [Vorteo releases](../../../docs/release.md#vorteo-releases). Only Vorteo :: Builds tags; other threads hand the request to Builds.

1. Confirm the commit this installation installed is on `origin/main` and passed its acceptance checks.
2. Run `node scripts/vorteo-release.mjs tag --channel beta --commit <installed commit> --dry-run`, then again without `--dry-run`. Add `--release` to publish the GitHub prerelease.
3. Report the tag, commit and version, and verify them with `node scripts/vorteo-release.mjs list --channel beta`.

Never use upstream `release:*` scripts or create `v*` tags. Never move or reuse a tag; fix forward.
