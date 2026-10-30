/**
 * The repository whose release tags installations upgrade to. Builds tags
 * `release-<version>` (stable) and `release-<version>-beta`, such as release-26.10.3001, with
 * scripts/vorteo-release.mjs after the install tests pass. Change the owner here
 * only; every server use derives from it.
 */
export const VORTEO_RELEASE_REPOSITORY = "terran-labs/vorteo";
export const VORTEO_RELEASE_GIT_URL = `https://github.com/${VORTEO_RELEASE_REPOSITORY}.git`;
