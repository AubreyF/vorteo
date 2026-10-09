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
import { z } from "zod";
import {
  ExecutionInstallationSchema,
  validateExecutionInstallation,
} from "@getpaseo/protocol/execution-installation";
import { BootstrapRequestConflict, type BootstrapHostBinding } from "./coordinator-bootstrap.js";

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
