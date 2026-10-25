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

async function realpathOrNull(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

/**
 * Paths whose project policies govern work in `cwd`: the folder itself, its real path, and the
 * main checkout of a git worktree, which may live outside the project folder. Real paths come
 * from the native resolver, which on Windows also expands 8.3 short names.
 */
async function governingPaths(cwd: string): Promise<string[]> {
  const paths = [resolve(cwd)];
  const real = await realpathOrNull(cwd);
  if (real) paths.push(real);
  try {
    const mainRoot = await getMainRepoRoot(cwd);
    paths.push(mainRoot);
    const realMainRoot = await realpathOrNull(mainRoot);
    if (realMainRoot) paths.push(realMainRoot);
  } catch {
    // Not a git checkout, so only the folder's own location applies.
  }
  return paths;
}

/**
 * The policies plus a copy of each under its project's real path, when that exists and differs,
 * so a key written through a symlink or a Windows 8.3 short name still matches real paths.
 */
async function withRealPolicyKeys(
  policies: Readonly<Record<string, InstallationProjectPolicy>>,
): Promise<Record<string, InstallationProjectPolicy>> {
  const expanded: Record<string, InstallationProjectPolicy> = { ...policies };
  for (const [key, policy] of Object.entries(policies)) {
    const real = await realpathOrNull(key);
    if (!real || real === key) continue;
    expanded[real] = unionPolicies(expanded[real], policy);
  }
  return expanded;
}

function unionPolicies(
  left: InstallationProjectPolicy | undefined,
  right: InstallationProjectPolicy,
): InstallationProjectPolicy {
  if (!left) return right;
  const union = (a: readonly string[] = [], b: readonly string[] = []) => [
    ...new Set([...a, ...b]),
  ];
  return {
    excludedEnvironments: [
      ...new Set([...(left.excludedEnvironments ?? []), ...(right.excludedEnvironments ?? [])]),
    ],
    providerIds: union(left.providerIds, right.providerIds),
    profileIds: union(left.profileIds, right.profileIds),
    skillIdentities: union(left.skillIdentities, right.skillIdentities),
  };
}

/** The policy that applies to work in `cwd`, matching both recorded and real paths. */
async function governingPolicy(
  policies: Readonly<Record<string, InstallationProjectPolicy>>,
  cwd: string,
): Promise<Required<InstallationProjectPolicy>> {
  const [expanded, paths] = await Promise.all([withRealPolicyKeys(policies), governingPaths(cwd)]);
  return effectiveProjectPolicy(expanded, paths);
}

/** The project exclusions that apply to work in `cwd`. Empty without project policies. */
export async function readProjectPolicy(
  admission: InstallationSettingsAdmission,
  cwd: string,
): Promise<Required<InstallationProjectPolicy>> {
  const policies = admission.settings.projectPolicies;
  if (!policies || Object.keys(policies).length === 0) return effectiveProjectPolicy({}, []);
  return governingPolicy(policies, cwd);
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
  assertProjectEnvironment(await governingPolicy(policies, cwd), environment);
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
