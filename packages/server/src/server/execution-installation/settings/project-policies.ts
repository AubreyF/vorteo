import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  effectiveProjectPolicy,
  type InstallationProjectPolicy,
} from "@getpaseo/protocol/installation-settings";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import { getMainRepoRoot } from "../../../utils/checkout-git.js";
import {
  InstallationSettingsAdmissionError,
  type InstallationSettingsAdmission,
} from "./admission.js";
import { localProjectPolicies } from "./projection.js";

const ENVIRONMENT_LABELS = { host: "Host", container: "Dev container" } as const;

/** A launch or workspace refused by the project's Exclusions setting. */
export class ProjectPolicyRefusal extends InstallationSettingsAdmissionError {
  constructor(
    readonly field: keyof InstallationProjectPolicy,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPolicyRefusal";
  }
}

export function changesProjectPolicies(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
): boolean {
  return (
    patch.installationProjectPolicies !== undefined &&
    !isDeepStrictEqual(patch.installationProjectPolicies, current.installationProjectPolicies ?? {})
  );
}

/** The daemon's copy only mirrors the coordinator; it never becomes an edit of its own. */
export function assertProjectPoliciesProjection(input: {
  current: MutableDaemonConfig;
  patch: MutableDaemonConfigPatch;
  admission?: InstallationSettingsAdmission;
}): void {
  if (!changesProjectPolicies(input.current, input.patch)) return;
  const { admission } = input;
  const authorized = admission ? localProjectPolicies(admission.settings, admission.serverId) : {};
  if (!admission || !isDeepStrictEqual(input.patch.installationProjectPolicies, authorized))
    throw new InstallationSettingsAdmissionError(
      "Project exclusions must be edited through the installation coordinator.",
    );
}

/**
 * Paths whose project policies govern work in `cwd`: the folder itself, its real path, and the
 * main checkout of a git worktree, which may live outside the project folder.
 */
async function governingPaths(cwd: string): Promise<string[]> {
  const paths = [resolve(cwd), await realpath(cwd)];
  try {
    paths.push(await getMainRepoRoot(cwd));
  } catch {
    // Not a git checkout, so only the folder's own location applies.
  }
  return paths;
}

/** The project exclusions that apply to work in `cwd`. Empty without project policies. */
export async function readProjectPolicy(
  admission: InstallationSettingsAdmission,
  cwd: string,
): Promise<Required<InstallationProjectPolicy>> {
  const policies = admission.settings.projectPolicies;
  if (!policies || Object.keys(policies).length === 0) return effectiveProjectPolicy({}, []);
  return effectiveProjectPolicy(policies, await governingPaths(cwd));
}

/** Refuse new work in a project excluded from this environment. */
function assertProjectEnvironment(
  policy: Required<InstallationProjectPolicy>,
  environment: ExecutionEnvironmentKind,
): void {
  if (!policy.excludedEnvironments.includes(environment)) return;
  throw new ProjectPolicyRefusal(
    "excludedEnvironments",
    `This project is excluded from the ${ENVIRONMENT_LABELS[environment]} environment. Change it in the project's settings under Exclusions.`,
  );
}

/**
 * Refuse a workspace in a project excluded from this environment. Uses the daemon's copy of the
 * policies, which only the coordinator can change, so creating a workspace needs no round trip.
 */
export async function assertWorkspaceEnvironment(
  config: MutableDaemonConfig,
  cwd: string,
): Promise<void> {
  const environment = config.sharedProviderPreferences?.installation?.environment;
  const policies = config.installationProjectPolicies;
  if (!environment || !policies || Object.keys(policies).length === 0) return;
  assertProjectEnvironment(
    effectiveProjectPolicy(policies, await governingPaths(cwd)),
    environment,
  );
}

/** Refuse an agent whose account or profile the project excludes. */
export function assertProjectLaunch(input: {
  policy: Required<InstallationProjectPolicy>;
  admission: InstallationSettingsAdmission;
  providerId: string;
  /** Requested and resolved identifiers of the selected profile, if any. */
  profileIds: readonly string[];
}): void {
  const { policy, admission } = input;
  assertProjectEnvironment(policy, admission.environment);
  const definition = admission.settings.providerDefinitions?.find(
    (entry) => entry.bindings[admission.serverId] === input.providerId,
  );
  if (definition && policy.providerIds.includes(definition.id))
    throw new ProjectPolicyRefusal(
      "providerIds",
      "This project excludes the selected account. Change it in the project's settings under Exclusions.",
    );
  if (input.profileIds.some((id) => policy.profileIds.includes(id)))
    throw new ProjectPolicyRefusal(
      "profileIds",
      "This project excludes the selected profile. Change it in the project's settings under Exclusions.",
    );
}
