import {
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
  const installation = validateExecutionInstallation(descriptor);
  if (installation.origin !== window.location.origin) {
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

export function installationDefaultServerId(
  installation: ExecutionInstallation | null,
): string | null {
  return (
    installation?.environments.find((environment) => environment.kind === "container")?.serverId ??
    null
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
