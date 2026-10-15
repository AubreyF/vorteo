import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";

const absolutePath = z.string().min(1).max(4096).startsWith("/");
const common = {
  version: z.literal(1),
  installationId: z.uuid(),
  custodyOwnerUid: z.number().int().nonnegative(),
  installationRoot: absolutePath,
  stateDirectory: absolutePath,
};

export const EnrollmentNativeIdentitySchema = z.discriminatedUnion("environment", [
  z.strictObject({
    ...common,
    environment: z.literal("host"),
    target: z.enum(["host", "coordinator", "maintenance-controller", "recovery-launcher"]),
    serviceDomain: z.string().regex(/^gui\/\d+$/),
    serviceLabel: z.string().regex(/^local\.vorteo\.[a-zA-Z0-9.-]+$/),
    launcherPath: absolutePath,
    selectionPath: absolutePath.nullable(),
  }),
  z.strictObject({
    ...common,
    environment: z.literal("container"),
    target: z.enum(["container-daemon", "supervisor"]),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    containerUid: z.number().int().nonnegative(),
    containerGid: z.number().int().nonnegative(),
    containerHome: absolutePath,
    containerStateDirectory: absolutePath,
    launcherPath: absolutePath,
    selectionPath: absolutePath.nullable(),
  }),
]);
export type EnrollmentNativeIdentity = z.infer<typeof EnrollmentNativeIdentitySchema>;

/** Callers independently inspect custody, registration and canonical paths before
 * hashing. PID, boot and selected release are observations, not stable identity. */
export function enrollmentNativeIdentityDigest(input: unknown): string {
  const identity = EnrollmentNativeIdentitySchema.parse(input);
  const paths = [
    identity.installationRoot,
    identity.stateDirectory,
    identity.launcherPath,
    identity.selectionPath,
  ];
  if (identity.environment === "host") {
    if (identity.serviceDomain !== `gui/${identity.custodyOwnerUid}`)
      throw new BootstrapRequestConflict("Enrolled service domain differs from its owner");
  } else paths.push(identity.containerHome, identity.containerStateDirectory);
  for (const value of paths) {
    if (
      value !== null &&
      (value.includes("\0") ||
        path.posix.normalize(value) !== value ||
        (value !== "/" && value.endsWith("/")))
    )
      throw new BootstrapRequestConflict("Enrolled identity requires canonical absolute paths");
  }
  // Schema parsing fixes field order, so input property order cannot change identity.
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
