import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  ServiceDescriptorSchema,
  SystemdUserServiceSchema,
  type InstallationConfig,
} from "./config.js";

/**
 * Stops, starts and restarts the installation's own services for snapshot restore
 * and release upgrades. These run outside the daemon restart queue only from the
 * detached handoff helper, after an owner approved the whole operation.
 */
export type ManagedService = "coordinator" | "host" | "dev";

export const ManagedServicesSchema = z.strictObject({
  coordinator: ServiceDescriptorSchema,
  host: ServiceDescriptorSchema,
  /** Dev's Compose deployment directory, holding common.sh from docker/multiplex. */
  dev: z.strictObject({ directory: z.string().startsWith("/") }).optional(),
});
export type ManagedServices = z.infer<typeof ManagedServicesSchema>;

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<string>;

const execFileAsync = promisify(execFile);

export const runCommand: CommandRunner = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, [...args], {
    timeout: options?.timeoutMs ?? 120_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

export interface ServiceControl {
  stop(service: ManagedService): Promise<void>;
  start(service: ManagedService): Promise<void>;
  restart(service: ManagedService): Promise<void>;
}

/** launchd needs the plist to start a stopped job; the installer writes it under LaunchAgents. */
function launchdCommands(label: string, launchAgents: string) {
  const match = /^gui\/(\d+)\/(.+)$/.exec(label);
  if (!match) throw new Error("Invalid launchd service");
  const plist = path.join(launchAgents, `${match[2]}.plist`);
  return {
    stop: ["/bin/launchctl", ["bootout", label]],
    start: ["/bin/launchctl", ["bootstrap", `gui/${match[1]}`, plist]],
    restart: ["/bin/launchctl", ["kickstart", "-k", label]],
  } as const;
}

function systemdCommands(service: z.infer<typeof SystemdUserServiceSchema>) {
  const systemctl = (verb: string) =>
    ["/usr/bin/systemctl", ["--user", verb, service.unit]] as const;
  return { stop: systemctl("stop"), start: systemctl("start"), restart: systemctl("restart") };
}

// Dev runs through the deployment's own Compose helpers, so its override files
// (Projects folder, Host loopback, gate mode) apply exactly as at installation.
function devCommands(directory: string) {
  const compose = (script: string) =>
    [
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail; deployment="$1"; source "$1/common.sh"; ${script}`,
        "-",
        directory,
      ],
    ] as const;
  return {
    stop: compose("paseo_compose stop paseo"),
    start: compose("paseo_compose up -d --no-deps --pull never paseo; paseo_wait"),
    restart: compose("paseo_compose restart paseo; paseo_wait"),
  };
}

export function createServiceControl(
  services: ManagedServices,
  run: CommandRunner = runCommand,
  launchAgents = path.join(homedir(), "Library", "LaunchAgents"),
): ServiceControl {
  function commands(service: ManagedService) {
    if (service === "dev") {
      if (!services.dev) throw new Error("This installation has no Dev container");
      return devCommands(services.dev.directory);
    }
    const descriptor = services[service];
    return "launchdService" in descriptor
      ? launchdCommands(descriptor.launchdService, launchAgents)
      : systemdCommands(descriptor.systemdService);
  }
  const timeoutMs = (service: ManagedService) => (service === "dev" ? 300_000 : 60_000);
  return {
    async stop(service) {
      const [command, args] = commands(service).stop;
      await run(command, args, { timeoutMs: timeoutMs(service) });
    },
    async start(service) {
      const [command, args] = commands(service).start;
      await run(command, args, { timeoutMs: timeoutMs(service) });
    },
    async restart(service) {
      const [command, args] = commands(service).restart;
      await run(command, args, { timeoutMs: timeoutMs(service) });
    },
  };
}

/** The installation's services, or why snapshot restore and upgrades cannot manage them. */
export function managedServices(
  config: Pick<InstallationConfig, "host" | "deployment" | "container">,
): ManagedServices | string {
  const coordinator = config.deployment?.coordinator?.service;
  if (!coordinator) return "The installer did not record the coordinator service.";
  const host =
    "launchdService" in config.host
      ? { launchdService: config.host.launchdService }
      : { systemdService: config.host.systemdService };
  if (!config.container) return { coordinator, host };
  const directory = config.deployment?.containerDirectory;
  if (!directory) return "The installer did not record Dev's deployment directory.";
  return { coordinator, host, dev: { directory } };
}
