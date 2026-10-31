import { reportBootFailure } from "@/appearance/boot-failure";
import {
  installationHasContainer,
  validateExecutionInstallation,
  type ExecutionInstallation,
  type InstallationEnvironment,
} from "@getpaseo/protocol/execution-installation";
import { isWeb } from "@/constants/platform";
import { isDemoSession } from "@/demo/mode";
import { isIsolatedDemoPreview } from "@/demo/preview";

export function readExecutionInstallation(): ExecutionInstallation | null {
  if (isDemoSession() || isIsolatedDemoPreview) return null;
  if (!isWeb || typeof window === "undefined") return null;
  const descriptor: unknown = Reflect.get(globalThis, "__VORTEO_EXECUTION_INSTALLATION__");
  if (descriptor === undefined) return null;
  let installation: ExecutionInstallation;
  try {
    installation = validateExecutionInstallation(descriptor);
  } catch (error) {
    reportBootFailure("installation-invalid");
    throw error;
  }
  if (installation.origin !== window.location.origin) {
    reportBootFailure("installation-origin-mismatch");
    throw new Error("Installation descriptor does not belong to this origin");
  }
  return installation;
}

export function findInstallationEnvironment(
  installation: ExecutionInstallation | null,
  serverId: string,
): InstallationEnvironment | null {
  return (
    installation?.environments.find((environment) => environment.serverId === serverId) ?? null
  );
}

/**
 * True when the installation has a Dev container beside the Host. Host-only installations
 * hide Dev rows, choices and copy; outside an installation there is no Dev to show.
 */
export function installationHasDev(installation: ExecutionInstallation | null): boolean {
  return installation !== null && installationHasContainer(installation);
}

const ALL_ENVIRONMENT_KINDS: readonly InstallationEnvironment["kind"][] = ["host", "container"];

/**
 * The environment kinds this installation runs, Host first. Without a descriptor, both kinds,
 * so settings stored for a two-environment installation keep their meaning.
 */
export function installationEnvironmentKinds(
  installation: ExecutionInstallation | null,
): readonly InstallationEnvironment["kind"][] {
  if (!installation) return ALL_ENVIRONMENT_KINDS;
  return ALL_ENVIRONMENT_KINDS.filter((kind) =>
    installation.environments.some((environment) => environment.kind === kind),
  );
}

/** New workspaces start in Dev when the installation has one, otherwise on the Host. */
export function installationDefaultServerId(
  installation: ExecutionInstallation | null,
): string | null {
  return (
    installation?.environments.find((environment) => environment.kind === "container")?.serverId ??
    installationHostServerId(installation)
  );
}

// The installation's Host daemon, which owns installation-wide work such as adding projects.
export function installationHostServerId(
  installation: ExecutionInstallation | null,
): string | null {
  return (
    installation?.environments.find((environment) => environment.kind === "host")?.serverId ?? null
  );
}

export function allowBrowserAutomation(installation: ExecutionInstallation | null): boolean {
  // Disable the entire automation bridge in the privileged installation client.
  // Capability omission alone is insufficient: unsolicited commands must also be denied.
  return installation === null;
}

export function allowClientPlugins(
  installation: ExecutionInstallation | null,
  serverId: string,
): boolean {
  return (
    installation === null ||
    installation.environments.some(
      (environment) => environment.kind === "host" && environment.serverId === serverId,
    )
  );
}
