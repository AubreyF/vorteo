import {
  effectiveProjectPolicy,
  type InstallationProjectPolicy,
} from "@getpaseo/protocol/installation-settings";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { profilePolicyIdentity } from "@getpaseo/protocol/provider-preferences";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";

type ProjectPolicy = Required<InstallationProjectPolicy>;

/**
 * The project's exclusions from a daemon's copy of the installation policies, or null when the
 * project is unknown or the daemon keeps no copy. The daemon names accounts by local provider id.
 * Launches are still checked by the daemon; this only keeps excluded choices out of menus.
 */
export function readProjectPolicy(
  config: Pick<MutableDaemonConfig, "installationProjectPolicies"> | null | undefined,
  projectPath: string | null | undefined,
): ProjectPolicy | null {
  const policies = config?.installationProjectPolicies;
  if (!projectPath || !policies) return null;
  return effectiveProjectPolicy(policies, [projectPath]);
}

export function isEnvironmentAllowed(
  policy: ProjectPolicy | null,
  kind: ExecutionEnvironmentKind | undefined,
): boolean {
  return !policy || !kind || !policy.excludedEnvironments.includes(kind);
}

export function isProfileAllowed(
  policy: ProjectPolicy | null,
  profile: { id: string; provider: string },
): boolean {
  return (
    !policy ||
    (!policy.profileIds.includes(profilePolicyIdentity(profile.id)) &&
      !policy.providerIds.includes(profile.provider))
  );
}
