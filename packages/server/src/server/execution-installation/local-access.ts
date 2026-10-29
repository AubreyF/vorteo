import type { IncomingHttpHeaders } from "node:http";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";

interface LocalRequest {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Only a direct request to either fixed loopback authority can select local credentials. */
export function localInstallationOrigin(
  config: Pick<InstallationConfig, "listenPort">,
  req: LocalRequest,
): string | null {
  const host = req.headers.host;
  const localHost =
    host === `127.0.0.1:${config.listenPort}` || host === `localhost:${config.listenPort}`;
  if (!localHost || !LOOPBACK.has(req.socket.remoteAddress ?? "")) return null;
  if (
    Object.keys(req.headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-"))
  ) {
    return null;
  }
  return `http://${host}`;
}

export function localInstallationEnvironments(
  config: Pick<InstallationConfig, "host" | "public">,
): InstallationEnvironment[] {
  const endpoint = new URL(`http://${config.host.endpoint}`);
  if (
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.host !== config.host.endpoint ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Local installation access requires a configured loopback Host endpoint");
  }
  return config.public.environments.map((environment) =>
    environment.kind === "host"
      ? { ...environment, endpoint: config.host.endpoint, useTls: false }
      : environment,
  );
}
