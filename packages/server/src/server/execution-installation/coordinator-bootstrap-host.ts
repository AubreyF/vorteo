import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  ExecutionInstallationSchema,
  validateExecutionInstallation,
} from "@getpaseo/protocol/execution-installation";
import { BootstrapRequestConflict, type BootstrapHostBinding } from "./coordinator-bootstrap.js";

const execute = promisify(execFile);

const CoordinatorBindingSchema = z.object({
  public: ExecutionInstallationSchema,
  ownerPasswordHash: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/),
  stateDir: z.string().startsWith("/"),
  host: z.object({ launchdService: z.string() }),
});

export interface ProtectedBootstrapHost {
  binding: BootstrapHostBinding;
  stateDirectory: string;
}

const ContainerMountInspectionSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  State: z.object({ Running: z.literal(true) }),
  Mounts: z.array(
    z.object({
      Type: z.enum(["bind", "volume", "tmpfs"]),
      Source: z.string().optional(),
      Name: z.string().optional(),
      RW: z.boolean(),
    }),
  ),
});
const VolumeInspectionSchema = z.array(
  z.object({
    Name: z.string().min(1),
    Driver: z.literal("local"),
    Scope: z.literal("local"),
    Options: z.record(z.string(), z.string()).nullable(),
  }),
);

/** Inputs must be read by the trusted Host Docker client, not supplied by an RPC.
 * Local volumes are VM storage only when their driver has no bind/device options. */
export function bootstrapWritableMountRoots(input: {
  container: unknown;
  containerId: string;
  volumes: unknown;
}): string[] {
  const container = ContainerMountInspectionSchema.parse(input.container);
  if (container.Id !== input.containerId)
    throw new BootstrapRequestConflict("Bootstrap container identity changed");
  const volumes = VolumeInspectionSchema.parse(input.volumes);
  const roots: string[] = [];
  for (const mount of container.Mounts) {
    if (!mount.RW || mount.Type === "tmpfs") continue;
    if (mount.Type === "bind") {
      if (!mount.Source || !path.isAbsolute(mount.Source))
        throw new BootstrapRequestConflict("Bootstrap mount has no absolute Host source");
      roots.push(mount.Source);
      continue;
    }
    const matches = volumes.filter((volume) => volume.Name === mount.Name);
    const volume = matches[0];
    if (matches.length !== 1 || !volume)
      throw new BootstrapRequestConflict("Bootstrap volume inspection is missing or ambiguous");
    if (volume.Options && Object.keys(volume.Options).length !== 0)
      throw new BootstrapRequestConflict("Bootstrap cannot verify a volume with driver options");
  }
  return [...new Set(roots)].sort();
}

/** The executable, local socket and immutable container ID come from Host setup.
 * Explicit endpoint and environment prevent profile Docker variables redirecting inspection. */
export async function inspectBootstrapWritableMountRoots(input: {
  docker: string;
  socket: string;
  containerId: string;
}): Promise<string[]> {
  if (process.platform !== "darwin")
    throw new BootstrapRequestConflict("Bootstrap Docker inspection requires native macOS Host");
  if (!path.isAbsolute(input.docker) || !path.isAbsolute(input.socket))
    throw new BootstrapRequestConflict("Bootstrap Docker paths must be absolute");
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.containerId);
  async function inspect(args: string[]): Promise<unknown> {
    const result = await execute(input.docker, ["--host", `unix://${input.socket}`, ...args], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  }
  const container = ContainerMountInspectionSchema.parse(
    await inspect([
      "container",
      "inspect",
      "--format",
      '{"Id":{{json .Id}},"State":{"Running":{{json .State.Running}}},"Mounts":{{json .Mounts}}}',
      input.containerId,
    ]),
  );
  if (container.Id !== input.containerId)
    throw new BootstrapRequestConflict("Bootstrap container identity changed");
  const volumes: unknown[] = [];
  const names = new Set<string>();
  for (const mount of container.Mounts) {
    if (mount.Type !== "volume" || !mount.RW) continue;
    const name = z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
      .parse(mount.Name);
    if (names.has(name)) continue;
    names.add(name);
    volumes.push(await inspect(["volume", "inspect", "--format", "{{json .}}", name]));
  }
  return bootstrapWritableMountRoots({ container, containerId: input.containerId, volumes });
}

function readPrivateBootstrapConfiguration(file: string, uid: number): unknown {
  if (realpathSync(file) !== file)
    throw new BootstrapRequestConflict("Bootstrap configuration requires a canonical Host path");
  const parent = lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Bootstrap configuration requires a private Host directory");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size > 1024n * 1024n
    )
      throw new BootstrapRequestConflict("Bootstrap configuration must be a private owned file");
    const bytes = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      after.ctimeNs !== current.ctimeNs ||
      after.mtimeNs !== current.mtimeNs
    )
      throw new BootstrapRequestConflict("Bootstrap configuration changed while reading");
    return JSON.parse(bytes);
  } finally {
    closeSync(fd);
  }
}

/** The file comes from the native launcher, never a profile or incoming RPC.
 * Mount exclusion is a separate Host inspection before this context is admitted. */
export function readBootstrapHostBinding(file: string, daemonId: string): ProtectedBootstrapHost {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new BootstrapRequestConflict("Bootstrap requires a native Host account");
  const config = CoordinatorBindingSchema.parse(readPrivateBootstrapConfiguration(file, uid));
  validateExecutionInstallation(config.public);
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!host || host.serverId !== daemonId)
    throw new BootstrapRequestConflict("Bootstrap is available only on the configured Host daemon");
  const servicePrefix = `gui/${uid}/local.vorteo.${config.public.installationId}`;
  if (config.host.launchdService !== `${servicePrefix}.host`)
    throw new BootstrapRequestConflict(
      "Bootstrap configuration has a different Host service identity",
    );
  if (realpathSync(config.stateDir) !== config.stateDir)
    throw new BootstrapRequestConflict("Coordinator state requires its canonical directory");
  const state = lstatSync(config.stateDir);
  if (!state.isDirectory() || state.uid !== uid || (state.mode & 0o077) !== 0)
    throw new BootstrapRequestConflict("Coordinator state requires a private Host directory");
  return {
    binding: {
      environment: "host",
      installationId: config.public.installationId,
      service: `${servicePrefix}.installation`,
      ownerPasswordHash: config.ownerPasswordHash,
    },
    stateDirectory: config.stateDir,
  };
}
