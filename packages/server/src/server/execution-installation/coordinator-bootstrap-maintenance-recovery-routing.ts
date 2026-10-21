import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import {
  readBootstrapPreparedFile,
  verifyBootstrapPreparedDependency,
} from "./coordinator-bootstrap-artifact.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";

const pin = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** The existing launcher plan digest binds the CLI and the complete previous
 * routing document. This is preparation evidence, never an effect reservation. */
export const MaintenanceRecoveryRouteSchema = z.strictObject({
  tailscale: pin,
  previousServe: pin,
});

const serveSchema = z.record(z.string(), z.unknown());
const backendSchema = z.object({
  BackendState: z.literal("Running"),
  Self: z.object({ DNSName: z.string().min(1) }),
});

type Access = NonNullable<
  NonNullable<z.infer<typeof MaintenanceLauncherSetupSchema>["control"]>["recoveryAccess"]
>;

export async function verifyMaintenanceRecoveryRouteArtifacts(input: {
  route: z.infer<typeof MaintenanceRecoveryRouteSchema>;
  writableMountRoots: readonly string[];
}) {
  // System-installed Tailscale is root-owned. Other prepared dependencies keep
  // their existing Host-only default; the pinned CLI still cannot be writable.
  await verifyBootstrapPreparedDependency(
    input.route.tailscale,
    input.writableMountRoots,
    "host-or-root",
  );
  const bytes = await readBootstrapPreparedFile(
    input.route.previousServe,
    input.writableMountRoots,
  );
  return serveSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/** The native caller supplies fresh read-only CLI results. A changed routing
 * document requires new preparation, not a merge that could erase another route.
 * Execution must separately consume its existing tracked lifecycle reservation. */
export function inspectMaintenanceRecoveryRouting(input: {
  access: Access;
  previousServe: unknown;
  currentServe: unknown;
  backend: unknown;
}) {
  const backend = backendSchema.parse(input.backend);
  const hostname = backend.Self.DNSName.replace(/\.$/, "");
  const origin = new URL(input.access.origin);
  const port = origin.port || "443";
  const previous = serveSchema.parse(input.previousServe);
  const current = serveSchema.parse(input.currentServe);
  if (
    origin.hostname !== hostname ||
    !hostname.endsWith(".ts.net") ||
    !isDeepStrictEqual(previous, current)
  )
    throw new BootstrapRequestConflict(
      "Recovery routing identity or retained configuration changed",
    );
  const tcp = z.record(z.string(), z.unknown()).optional().parse(current.TCP);
  const web = z.record(z.string(), z.unknown()).optional().parse(current.Web);
  const funnel = z.record(z.string(), z.unknown()).optional().parse(current.AllowFunnel);
  const webPort = (key: string) => key.endsWith(`:${port}`);
  const occupied =
    Object.hasOwn(tcp ?? {}, port) ||
    Object.keys(web ?? {}).some(webPort) ||
    Object.keys(funnel ?? {}).some(webPort);
  if (occupied)
    throw new BootstrapRequestConflict("Recovery HTTPS port already has routing configuration");
  return {
    origin: input.access.origin,
    arguments: ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${input.access.listenPort}`],
    previousServe: previous,
  };
}

/** Observe one additive private route, including all unrelated settings. This
 * does not dispatch or accept a partial result after an uncertain CLI reply. */
export function verifyMaintenanceRecoveryRouteSelection(
  input: Parameters<typeof inspectMaintenanceRecoveryRouting>[0],
) {
  const prepared = inspectMaintenanceRecoveryRouting({
    ...input,
    currentServe: input.previousServe,
  });
  const current = structuredClone(serveSchema.parse(input.currentServe));
  const origin = new URL(prepared.origin);
  const port = origin.port || "443";
  const address = `${origin.hostname}:${port}`;
  const tcp = z.record(z.string(), z.unknown()).parse(current.TCP);
  const web = z.record(z.string(), z.unknown()).parse(current.Web);
  const expected = {
    Handlers: { "/": { Proxy: `http://127.0.0.1:${input.access.listenPort}` } },
  };
  if (!isDeepStrictEqual(tcp[port], { HTTPS: true }) || !isDeepStrictEqual(web[address], expected))
    throw new BootstrapRequestConflict("Recovery route does not select the exact private listener");
  const funnel = z.record(z.string(), z.unknown()).optional().parse(current.AllowFunnel);
  if (funnel && Object.hasOwn(funnel, address)) {
    if (funnel[address] !== false)
      throw new BootstrapRequestConflict("Recovery route must not enable public exposure");
    delete funnel[address];
  }
  delete tcp[port];
  delete web[address];
  current.TCP = tcp;
  current.Web = web;
  if (funnel) current.AllowFunnel = funnel;
  for (const key of ["TCP", "Web", "AllowFunnel"]) {
    const value = current[key];
    if (
      !Object.hasOwn(prepared.previousServe, key) &&
      value &&
      Object.keys(z.record(z.string(), z.unknown()).parse(value)).length === 0
    )
      delete current[key];
  }
  if (!isDeepStrictEqual(current, prepared.previousServe))
    throw new BootstrapRequestConflict("Unrelated private routing changed during activation");
  return { origin: prepared.origin, ready: true as const };
}
