---
name: release-stable
description: Cut a stable release of Vorteo by promoting a beta. Use when the user says "release stable", "ship stable", "promote", "release:patch", "release:minor", "release:promote", or "/release-stable".
user-invocable: true
---

# Release stable

Follow [Vorteo releases](../../../docs/release.md#vorteo-releases). Stable needs the owner's explicit request and goes only on a commit that already has its beta tag. Only Vorteo :: Builds tags.

1. Pick the beta tag to promote and confirm the owner asked for that one.
2. Run `node scripts/vorteo-release.mjs tag --channel stable --commit <beta-tagged commit> --dry-run`, then again without `--dry-run`. Add `--release` to publish the GitHub Release.
3. Report the tag, commit and version, and verify them with `node scripts/vorteo-release.mjs list --channel stable`.

`release:patch`, `release:minor` and `release:promote` are upstream Paseo commands; never run them for Vorteo. Never create `v*` tags, and never move or reuse a tag.
