import { expect, test } from "vitest";
import { isEnvironmentAllowed, isProfileAllowed, readProjectPolicy } from "./project-policy";

const config = {
  installationProjectPolicies: {
    "/Users/me/dev/app": {
      excludedEnvironments: ["container" as const],
      providerIds: ["claude-work"],
      profileIds: ["workflow/review", "local-profile"],
    },
  },
};

test("choosers hide environments, accounts and profiles a project excludes", () => {
  const policy = readProjectPolicy(config, "/Users/me/dev/app/packages/web");
  expect(isEnvironmentAllowed(policy, "container")).toBe(false);
  expect(isEnvironmentAllowed(policy, "host")).toBe(true);
  expect(isProfileAllowed(policy, { id: "default", provider: "claude-work" })).toBe(false);
  // Shared workflows match in every environment, whichever local account names them.
  expect(isProfileAllowed(policy, { id: "shared-profile/codex/review", provider: "codex" })).toBe(
    false,
  );
  expect(isProfileAllowed(policy, { id: "shared-workflow/claude-b/review", provider: "x" })).toBe(
    false,
  );
  expect(isProfileAllowed(policy, { id: "local-profile", provider: "codex" })).toBe(false);
  expect(isProfileAllowed(policy, { id: "default", provider: "codex" })).toBe(true);
});

test("choosers offer everything when the project or the daemon copy is unknown", () => {
  for (const policy of [
    readProjectPolicy(config, null),
    readProjectPolicy({}, "/Users/me/dev/app"),
    readProjectPolicy(config, "/Users/me/dev/other"),
  ]) {
    expect(isEnvironmentAllowed(policy, "container")).toBe(true);
    expect(isProfileAllowed(policy, { id: "default", provider: "claude-work" })).toBe(true);
  }
});
