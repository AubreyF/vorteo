import type { PluginRequirements } from "./messages.js";
import parse from "semver/functions/parse.js";
import validRange from "semver/ranges/valid.js";
import satisfies from "semver/functions/satisfies.js";

export function validatePluginRequirements(requirements: PluginRequirements | undefined): void {
  const range = requirements?.paseo;
  if (range !== undefined && (!range.trim() || validRange(range) === null)) {
    throw new Error(
      `Invalid requirements.paseo: ${JSON.stringify(range)}. Use an npm semver range such as ">=0.8.0".`,
    );
  }
}

interface PluginCompatibilityInput {
  id: string;
  requirements?: PluginRequirements;
  version: string | null;
  runtime: "daemon" | "app";
}

export function assertPluginCompatibility(input: PluginCompatibilityInput): void {
  validatePluginRequirements(input.requirements);
  // COMPAT(plugin-requirements): added in v0.8.0-beta.1; remove after 2027-03-07 once pre-0.8 plugins and catalogs are unsupported. The legacy range excludes 0.8 prereleases and their stable core.
  const range = input.requirements?.paseo ?? "<0.8.0";
  const version = input.version ? parse(input.version) : null;
  if (!version) {
    throw new Error(
      `Cannot check plugin "${input.id}" requirements: Vorteo ${input.runtime} version is unknown. Update the ${input.runtime}.`,
    );
  }
  const stableCore = `${version.major}.${version.minor}.${version.patch}`;
  // Inspect authored branches: semver generates prerelease upper bounds for
  // stable caret, tilde and wildcard ranges. Those still allow stable-core matching.
  const matchesStableBranch = range.split("||").some((branch) => {
    const explicitPrerelease = /(?:^|[\s<>=~^])v?[0-9xX*]+(?:\.[0-9xX*]+){0,2}-[0-9A-Za-z-]/.test(
      branch,
    );
    return !explicitPrerelease && satisfies(stableCore, branch);
  });
  if (satisfies(version, range) || matchesStableBranch) return;
  const action =
    input.requirements?.paseo === undefined
      ? "This plugin has no requirements.paseo and targets Vorteo before 0.8. Ask its author to migrate it: https://paseo.sh/docs/plugins/migration"
      : `Use a compatible plugin version or update the ${input.runtime}.`;
  throw new Error(
    `Plugin "${input.id}" requires Vorteo ${range}. Your ${input.runtime} is ${input.version}. ${action}`,
  );
}
