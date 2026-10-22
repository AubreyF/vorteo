import path from "node:path";

/** Stored in `project.systemProject.kind`; the daemon finds its system project by this, never by ID. */
export const SYSTEM_PROJECT_KIND = "vorteo-system";
export const SYSTEM_PROJECT_NAME = "Vorteo System";

/**
 * Where this daemon runs. Host and container come from the installation's shared
 * preferences; a daemon without an installation is a single, standalone install.
 */
export type SystemEnvironment = "host" | "container" | "single";

export interface SystemRole {
  role: string;
  title: string;
  environments: readonly SystemEnvironment[];
}

/**
 * System-managed workspaces each daemon keeps in its Vorteo System project.
 * The Host runner also covers the Dev container, so the container has none
 * until monitoring ships its collector.
 */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  { role: "optimization-runner", title: "Optimization Runner", environments: ["host", "single"] },
];

export function rolesForEnvironment(environment: SystemEnvironment): SystemRole[] {
  return SYSTEM_ROLES.filter((role) => role.environments.includes(environment));
}

/** Every system path lives under `$PASEO_HOME/system`, outside any source checkout. */
export function systemPaths(paseoHome: string) {
  const root = path.join(paseoHome, "system");
  return {
    root,
    /** Project root. Empty until the operator sets up Vorteo source, then a git clone. */
    source: path.join(root, "vorteo"),
    /** Install-local settings. Kept out of config.json so older daemons still start. */
    config: path.join(root, "system.json"),
    runner: (role: string) => path.join(root, "runners", role),
  };
}
