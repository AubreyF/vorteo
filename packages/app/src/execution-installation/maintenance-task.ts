import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";

/**
 * Where an update or merge task can run.
 *
 * - `ready`: the Host environment is connected and receives the draft.
 * - `no-host`: this installation predates Host environments. A web page served without an
 *   installation descriptor comes straight from a Dev container's daemon, and a container
 *   cannot install its own Host, so the owner must run the installer on the Docker computer.
 * - `host-offline`: a Host exists but is not connected, or this client cannot tell (native
 *   apps and demos never receive a descriptor).
 */
export type MaintenanceTaskTarget =
  | { status: "ready"; serverId: string }
  | { status: "no-host" }
  | { status: "host-offline" };

export function resolveMaintenanceTaskTarget(
  installation: ExecutionInstallation | null,
  serverIds: readonly string[],
  descriptorExpected: boolean,
): MaintenanceTaskTarget {
  const host = installation?.environments.find((environment) => environment.kind === "host");
  if (host && serverIds.includes(host.serverId))
    return { status: "ready", serverId: host.serverId };
  if (host) return { status: "host-offline" };
  if (installation || descriptorExpected) return { status: "no-host" };
  return { status: "host-offline" };
}

export function maintenanceTaskTarget(
  installation: ExecutionInstallation | null,
  serverIds: readonly string[],
  descriptorExpected = false,
): string {
  const target = resolveMaintenanceTaskTarget(installation, serverIds, descriptorExpected);
  if (target.status === "ready") return target.serverId;
  if (target.status === "no-host")
    throw new Error(
      "This installation has no Host environment. Run the Vorteo installer on the computer that runs Docker to add one.",
    );
  throw new Error("Connect this installation's host environment before preparing an update task.");
}

export function installationMaintenancePrompt(prompt: string): string {
  return `${prompt}\n\nExecution and installation boundaries\nThis task is explicitly targeted at the trusted native host environment. Inspect the installation record and both daemon identities. Preserve the running development container and unrelated work. Build a reviewed release outside guest-writable directories; do not execute the installed host service from a shared development checkout. Use the installation-maintenance skill to request any necessary restart, wait for owner approval of that exact request, and verify its durable readiness result. Do not bypass the coordinator with shell restarts or recreate the primary container. Report source, installed release, remote publication, and real-device acceptance separately.`;
}
