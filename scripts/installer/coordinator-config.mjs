// Pure builders for the files an installation's services read. The coordinator
// configuration shape is shared with the Coordinator workstream:
// - `container` is omitted for a Host-only installation, and then
//   `public.environments` holds only the Host.
// - `access.remote` is "tailscale" or "none"; with "none", `public.origin` is exactly
//   http://localhost:<listenPort>.
// - `deployment` gives absolute paths so interface upgrades can find the Host
//   installation root, the source checkout and the Dev deployment.
import path from "node:path";
import { publicOrigin } from "./plan.mjs";
import { COORDINATOR_ENTRYPOINT, SUPERVISOR_ENTRYPOINT, WEB_DIST } from "./host-installation.mjs";
import { HOST_EXIT_TIMEOUT_SECONDS } from "./launchd.mjs";

const PLATFORM_PATH = {
  darwin: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  linux: "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
};

/** Origins of the coordinator on Host loopback, which local access serves. */
export function localOrigins(plan) {
  return [
    `http://localhost:${plan.ports.coordinator}`,
    `http://127.0.0.1:${plan.ports.coordinator}`,
  ];
}

/** Every browser origin the interface may load from; daemons allow exactly these. */
export function interfaceOrigins(plan, hostname) {
  const remote = plan.remote.mode === "tailscale" ? [publicOrigin(plan, hostname)] : [];
  return [...remote, ...localOrigins(plan)];
}

/** The name Dev answers to: the Host's tailnet name, or localhost without Tailscale. */
export function devPublicHostname(plan, hostname) {
  return plan.remote.mode === "tailscale" ? hostname : "localhost";
}

/**
 * Gate routes let Dev's installation client reach the coordinator, whose address is in
 * a range the gate refuses. With Tailscale that is the HTTPS origin on the tailnet.
 * Without it the coordinator listens only on Host loopback, so the route names the Host
 * through `host.docker.internal`, which only the gate resolves. Docker Desktop forwards
 * that name to Host loopback; on Linux it reaches the Docker bridge gateway instead,
 * where the coordinator does not listen.
 */
export function gateRoutes(plan, hostname) {
  return plan.remote.mode === "tailscale"
    ? [`${hostname}:${plan.ports.https}`]
    : [localGateAuthority(plan)];
}

/** The coordinator origin Dev's installation client uses: the tailnet origin, or the gate route. */
export function devClientOrigin(plan, hostname) {
  return plan.remote.mode === "tailscale"
    ? publicOrigin(plan, hostname)
    : `http://${localGateAuthority(plan)}`;
}

/** The authority Dev uses for the coordinator without Tailscale; only the gate resolves it. */
export function localGateAuthority(plan) {
  return `host.docker.internal:${plan.ports.coordinator}`;
}

/**
 * Without Tailscale, Dev reaches the coordinator through the gate's named route. Docker
 * Desktop forwards host.docker.internal to Host loopback; on Linux it is the Docker bridge
 * gateway, so the coordinator also listens there (plan.dev.bridgeAddress).
 */
function gateRoute(plan) {
  if (plan.remote.mode === "tailscale" || !plan.devContainer) return {};
  return {
    gateRoute: {
      authority: localGateAuthority(plan),
      ...(plan.platform === "linux" && plan.dev?.bridgeAddress
        ? { listenAddress: plan.dev.bridgeAddress }
        : {}),
    },
  };
}

export function hostClientFile(plan) {
  return path.join(plan.paths.host, "host-agent.json");
}

export function buildCoordinatorConfig({
  plan,
  hostname,
  hostServerId,
  containerServerId,
  hostPassword,
  containerPassword,
  hashes,
  hostService,
  coordinatorService,
}) {
  const tailscale = plan.remote.mode === "tailscale";
  const environment = (kind, serverId, tlsPort, loopbackPort) => ({
    kind,
    serverId,
    endpoint: tailscale ? `${hostname}:${tlsPort}` : `127.0.0.1:${loopbackPort}`,
    useTls: tailscale,
  });
  const environments = [
    ...(plan.devContainer
      ? [environment("container", containerServerId, plan.ports.devHttps, plan.ports.devRelay)]
      : []),
    environment("host", hostServerId, plan.ports.hostHttps, plan.ports.host),
  ];
  return {
    public: {
      version: 1,
      installationId: plan.installationId,
      origin: publicOrigin(plan, hostname),
      environments,
    },
    access: { remote: tailscale ? "tailscale" : "none", ...gateRoute(plan) },
    deployment: {
      installRoot: plan.paths.root,
      sourceDirectory: plan.paths.source,
      hostHome: plan.paths.hostHome,
      hostReleaseLink: plan.paths.hostReleaseLink,
      coordinator: {
        releaseLink: plan.paths.coordinatorReleaseLink,
        service: coordinatorService,
      },
      ...(plan.devContainer
        ? {
            containerDirectory: plan.paths.container,
            containerHome: path.join(plan.paths.container, "data", "home"),
          }
        : {}),
    },
    listenPort: plan.ports.coordinator,
    // Served through the coordinator's link, so its replacement brings the interface along.
    webDistDir: path.join(plan.paths.coordinatorReleaseLink, WEB_DIST),
    stateDir: plan.paths.coordinatorState,
    ownerPasswordFile: plan.paths.ownerPassword,
    ownerPasswordHash: hashes.owner,
    hostAgentTokenHash: hashes.hostAgent,
    // Required by the current schema even without Dev; nothing holds this token then.
    containerAgentTokenHash: hashes.containerAgent,
    host: {
      endpoint: `127.0.0.1:${plan.ports.host}`,
      password: hostPassword,
      ...hostService,
      startupValidation: {
        node: plan.executables.node,
        entrypoint: path.join(plan.paths.hostReleaseLink, SUPERVISOR_ENTRYPOINT),
        home: plan.paths.hostHome,
      },
    },
    ...(plan.devContainer
      ? { container: { endpoint: `127.0.0.1:${plan.ports.devRelay}`, password: containerPassword } }
      : {}),
  };
}

/** The Host daemon and coordinator service definitions, for either service manager. */
export function describeServices(plan) {
  const nodeDirectory = path.dirname(plan.executables.node);
  const env = {
    HOME: plan.paths.home,
    PATH: `${nodeDirectory}:${PLATFORM_PATH[plan.platform] ?? PLATFORM_PATH.linux}`,
    PASEO_HOME: plan.paths.hostHome,
    VORTEO_INSTALLATION_CLIENT_CONFIG: hostClientFile(plan),
  };
  return [
    {
      role: "host",
      label: plan.services.host,
      description: `Vorteo ${plan.name} Host daemon`,
      argv: [plan.executables.node, path.join(plan.paths.hostReleaseLink, SUPERVISOR_ENTRYPOINT)],
      env,
      log: path.join(plan.paths.logs, "host.log"),
      exitTimeout: HOST_EXIT_TIMEOUT_SECONDS,
    },
    {
      role: "coordinator",
      label: plan.services.coordinator,
      description: `Vorteo ${plan.name} installation coordinator`,
      argv: [
        plan.executables.node,
        path.join(plan.paths.coordinatorReleaseLink, COORDINATOR_ENTRYPOINT),
        plan.paths.coordinatorConfig,
      ],
      env,
      log: path.join(plan.paths.logs, "installation.log"),
    },
  ];
}
