import { PreviewMonitorConfigurationSchema } from "@getpaseo/protocol/preview-monitor-maintenance";
import { NativeHelperConfigurationSchema } from "@getpaseo/protocol/native-helper-maintenance";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  EngineRestartConfigurationSchema,
  EngineRecoveryConfigurationSchema,
  RecoveryOriginSchema,
  ExecutionInstallationSchema,
  FactoryGateConfigurationSchema,
  HostLauncherUpdateConfigurationSchema,
  FactoryRuntimeAdoptionConfigurationSchema,
  installationHasContainer,
  validateExecutionInstallation,
} from "@getpaseo/protocol/execution-installation";

import { DevRegistrationReferenceSchema } from "./maintenance/dev-registration.js";

const DaemonConnectionSchema = z.strictObject({
  endpoint: z.string().min(1),
  password: z.string().min(1),
});

export const ContainerSourceUpdatesSchema = z.strictObject({
  sourceRepository: z.string().startsWith("/"),
  toolingDirectory: z.string().startsWith("/"),
  integrationRef: z.string().regex(/^refs\/heads\/[a-zA-Z0-9_./-]+$/),
  receiptFile: z.string().startsWith("/"),
  docker: z.string().startsWith("/"),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  node: z.string().startsWith("/"),
  home: z.string().startsWith("/"),
  releaseRoot: z.string().startsWith("/"),
  currentReleaseLink: z.string().startsWith("/"),
});
export type ContainerSourceUpdates = z.infer<typeof ContainerSourceUpdatesSchema>;

/** A unit of the owner account's `systemd --user` manager. The account is
 * explicit because, unlike a launchd `gui/<uid>` label, a unit name has none. */
export const SystemdUserServiceSchema = z.strictObject({
  kind: z.literal("systemd-user"),
  uid: z.number().int().nonnegative(),
  unit: z
    .string()
    .max(255)
    .regex(/^local\.vorteo\.[a-zA-Z0-9.-]+\.service$/),
});

const HostDaemonSchema = DaemonConnectionSchema.extend({
  startupValidation: z
    .strictObject({
      node: z.string().startsWith("/"),
      entrypoint: z.string().startsWith("/"),
      home: z.string().startsWith("/"),
    })
    .optional(),
  /** One-time Host launcher update adding the managed release link and root. */
  launcherUpdate: HostLauncherUpdateConfigurationSchema.optional(),
});

const ContainerDaemonSchema = DaemonConnectionSchema.extend({
  persistentRegistration: DevRegistrationReferenceSchema.optional(),
  factoryRuntimeAdoption: FactoryRuntimeAdoptionConfigurationSchema.optional(),
  engineRestart: EngineRestartConfigurationSchema.optional(),
  engineRecovery: EngineRecoveryConfigurationSchema.optional(),
  factoryGate: FactoryGateConfigurationSchema.optional(),
  supervisorMaintenance: z
    .strictObject({
      node: z.string().startsWith("/"),
      script: z.string().startsWith("/"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export type ContainerDaemonConfig = z.infer<typeof ContainerDaemonSchema>;

const absolutePath = z.string().startsWith("/");

/**
 * How owners reach the interface. `tailscale` (the default when omitted) serves
 * `public.origin` as a tailnet HTTPS origin. `none` serves it only on Host loopback,
 * at exactly `http://localhost:<listenPort>`.
 */
export const InstallationAccessSchema = z.strictObject({
  remote: z.enum(["tailscale", "none"]),
  /**
   * Dev in gate mode reaches the coordinator through a gate route: an exact
   * `hostname:port` that the gate's `routes` list also names, normally
   * `host.docker.internal:<listenPort>`. The coordinator accepts this authority
   * only on agent API routes, never for the owner interface.
   */
  gateRoute: z
    .strictObject({
      authority: z.string().regex(/^[a-z0-9.-]+:\d{4,5}$/),
      /** Extra IPv4 listen address for Linux Docker bridges; Docker Desktop reaches loopback. */
      listenAddress: z.ipv4().optional(),
    })
    .optional(),
});
export type InstallationAccess = z.infer<typeof InstallationAccessSchema>;

/** A launchd label (`gui/<uid>/local.vorteo.*`) or a systemd user unit. */
export const ServiceDescriptorSchema = z.union([
  z.strictObject({
    launchdService: z.string().regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+$/),
  }),
  z.strictObject({ systemdService: SystemdUserServiceSchema }),
]);
export type ServiceDescriptor = z.infer<typeof ServiceDescriptorSchema>;

/**
 * Where the one-command installer put this installation. Every path is absolute.
 * Release upgrades and safety snapshots require it; older installations omit it.
 */
export const InstallationDeploymentSchema = z.strictObject({
  /** `~/vorteo`: holds `source`, `host`, `container` and `state`. */
  installRoot: absolutePath,
  /** Git checkout that release upgrades fetch tags into. */
  sourceDirectory: absolutePath,
  /** Dev's Compose deployment (`.env`, compose files, gate configuration). */
  containerDirectory: absolutePath.optional(),
  /** Coordinator self-replacement. Without it, upgrades stop after the Host daemon. */
  coordinator: z
    .strictObject({
      /** Symlink the coordinator service runs through; upgrades repoint it. */
      releaseLink: absolutePath,
      service: ServiceDescriptorSchema,
    })
    .optional(),
  /**
   * Symlink the Host service runs through. With it and no `sourceUpdates`, upgrades build
   * the Host release with the installer engine and repoint this link.
   */
  hostReleaseLink: absolutePath.optional(),
  /** Host daemon home (`PASEO_HOME`), captured by snapshots. */
  hostHome: absolutePath.optional(),
  /** Dev daemon home on the Host when it is a bind mount; otherwise snapshots use docker cp. */
  containerHome: absolutePath.optional(),
});
export type InstallationDeployment = z.infer<typeof InstallationDeploymentSchema>;

export const InstallationConfigSchema = z.strictObject({
  public: ExecutionInstallationSchema,
  /** Only an explicitly reviewed private configuration enables operational sampling. */
  operationalTelemetryEnabled: z.literal(true).optional(),
  nativeHelper: NativeHelperConfigurationSchema.optional(),
  previewMonitor: PreviewMonitorConfigurationSchema.optional(),
  restartApprovalPolicy: z.strictObject({ hostRequestsAfter: z.string().datetime() }).optional(),
  containerSourceUpdates: ContainerSourceUpdatesSchema.optional(),
  /** Off by default. Full sign-in Claude accounts with Host-owned refresh; `true` opts in. */
  claudeHostRefresh: z.boolean().optional(),
  /** Off by default. Shared Codex accounts sign in once on the Host and reach Dev; `true` opts in. */
  codexHostRefresh: z.boolean().optional(),
  sourceUpdates: z
    .strictObject({
      sourceRepository: z.string().startsWith("/"),
      releaseRoot: z.string().startsWith("/"),
      currentReleaseLink: z.string().startsWith("/"),
      webDirectory: z.string().startsWith("/"),
      toolingDirectory: z.string().startsWith("/"),
      integrationRef: z.string().regex(/^refs\/heads\/[a-zA-Z0-9_./-]+$/),
    })
    .optional(),
  redirectOrigins: z
    .array(
      z.url().refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value;
      }, "Redirect origins must be exact HTTPS origins"),
    )
    .optional(),
  recoveryOrigin: RecoveryOriginSchema.optional(),
  listenPort: z.number().int().min(1024).max(65535),
  webDistDir: z.string().min(1),
  stateDir: z.string().min(1),
  ownerPasswordFile: z.string().min(1).optional(),
  ownerPasswordHash: z.string().startsWith("$2"),
  hostAgentTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  containerAgentTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  // The Host service is tagged by its manager; exactly one descriptor is present.
  host: z.union([
    HostDaemonSchema.extend({
      launchdService: z.string().regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+$/),
    }),
    HostDaemonSchema.extend({ systemdService: SystemdUserServiceSchema }),
  ]),
  /** Absent for a Host-only installation; then `public.environments` lists only the Host. */
  container: ContainerDaemonSchema.optional(),
  access: InstallationAccessSchema.optional(),
  deployment: InstallationDeploymentSchema.optional(),
});
export type InstallationConfig = z.infer<typeof InstallationConfigSchema>;

/**
 * Host-owned Claude refresh stays opt-in: the default belongs to the Accounts owner, so only an
 * explicit `claudeHostRefresh: true` enables it.
 */
export function claudeHostRefreshEnabled(config: Pick<InstallationConfig, "claudeHostRefresh">) {
  return config.claudeHostRefresh === true;
}

/** Installation config with a Dev container; container-only paths take this. */
export type ContainerInstallationConfig = InstallationConfig & { container: ContainerDaemonConfig };

export function hasContainer(config: InstallationConfig): config is ContainerInstallationConfig {
  return config.container !== undefined;
}

/** Dev settings for container-only paths. Host-only installations refuse them plainly. */
export function requireContainer(config: InstallationConfig): ContainerDaemonConfig {
  if (!config.container) throw new Error("This installation has no Dev container");
  return config.container;
}

/** The loopback connection for one environment; Dev exists only with a container. */
export function requireEnvironmentDaemon(
  config: InstallationConfig,
  kind: "host" | "container",
): { endpoint: string; password: string } {
  return kind === "host" ? config.host : requireContainer(config);
}

/** Daemon restart targets this installation has: the Host, plus Dev when it exists. */
export function daemonTargets(
  config: Pick<InstallationConfig, "public">,
): ("host" | "container-daemon")[] {
  return installationHasContainer(config.public) ? ["host", "container-daemon"] : ["host"];
}

export function remoteAccess(config: Pick<InstallationConfig, "access">): "tailscale" | "none" {
  return config.access?.remote ?? "tailscale";
}

/** Same rule as Claude: only an explicit `codexHostRefresh: true` enables it. */
export function codexHostRefreshEnabled(config: Pick<InstallationConfig, "codexHostRefresh">) {
  return config.codexHostRefresh === true;
}

export function hostLaunchdService(config: InstallationConfig): string {
  if (!("launchdService" in config.host))
    throw new Error("Host operations through systemd are not supported yet");
  return config.host.launchdService;
}

export function readInstallationConfig(file: string): InstallationConfig {
  const config = InstallationConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  validateExecutionInstallation(config.public);
  if (process.platform === "darwin" && !("launchdService" in config.host))
    throw new Error("A macOS Host requires its launchd service");
  if (config.hostAgentTokenHash === config.containerAgentTokenHash)
    throw new Error("Host and Dev installation request credentials must be distinct");
  if (config.sourceUpdates) {
    const update = config.sourceUpdates;
    const entrypoint = path.join(
      update.currentReleaseLink,
      "packages/server/dist/scripts/supervisor-entrypoint.js",
    );
    if (
      config.host.startupValidation?.entrypoint !== entrypoint ||
      config.webDistDir !== update.webDirectory
    )
      throw new Error(
        "Source updates require the selected release launcher and managed web directory",
      );
  }
  for (const target of [config.host, ...(config.container ? [config.container] : [])]) {
    if (!/^127\.0\.0\.1:\d+$/.test(target.endpoint)) {
      throw new Error("Installation management connects only to explicit host loopback endpoints");
    }
  }
  if (config.container && config.host.password === config.container.password) {
    throw new Error("Host and container daemon credentials must be distinct");
  }
  validateEnvironmentSet(config);
  validateAccess(config);
  return config;
}

/** `container` and a public `container` environment come and go together. */
function validateEnvironmentSet(config: InstallationConfig): void {
  const publicContainer = config.public.environments.some(
    (environment) => environment.kind === "container",
  );
  if (publicContainer !== (config.container !== undefined))
    throw new Error(
      config.container
        ? "A Dev container requires its public container environment"
        : "A Host-only installation lists only the Host environment",
    );
  if (!config.container && (config.containerSourceUpdates || config.deployment?.containerDirectory))
    throw new Error("Dev container settings require a configured Dev container");
}

function validateAccess(config: InstallationConfig): void {
  if (remoteAccess(config) !== "none") return;
  if (config.public.origin !== `http://localhost:${config.listenPort}`)
    throw new Error("Local-only access serves exactly http://localhost:<listenPort>");
  if (config.recoveryOrigin || config.redirectOrigins?.length)
    throw new Error("Local-only access has no remote recovery or redirect origins");
}
