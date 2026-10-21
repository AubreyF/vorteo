import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import {
  readProtectedDocument,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";

/** Read-only health on the existing maintenance listener. This is not a grant,
 * dispatch credential, or substitute for independent native process inspection. */
export const MaintenanceRuntimeStatusSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().uuid(),
  installationId: z.string().uuid(),
  target: z.enum(["maintenance-controller", "recovery-launcher"]),
  identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  process: BootstrapProcessIdentitySchema,
  ready: z.boolean(),
});
export type MaintenanceRuntimeStatus = z.infer<typeof MaintenanceRuntimeStatusSchema>;
export type MaintenanceRuntimeIdentity = Omit<
  MaintenanceRuntimeStatus,
  "version" | "nonce" | "ready"
>;

/** The port comes from the existing protected descriptor after its process was
 * independently verified. No redirects, arbitrary origins or bearer tokens. */
export async function readMaintenanceRuntimeReadiness(input: {
  port: number;
  expected: MaintenanceRuntimeIdentity;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<{ ready: boolean; assertCurrent(): void }> {
  z.number().int().min(1).max(65535).parse(input.port);
  const nonce = randomUUID();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5000)]);
  const response = await fetch(
    `http://127.0.0.1:${input.port}/api/installation/maintenance/runtime-status?nonce=${nonce}`,
    { signal, redirect: "error", cache: "no-store" },
  );
  if (!response.ok || !response.body)
    throw new BootstrapRequestConflict("Maintenance runtime readiness is unavailable");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16 * 1024)
        throw new BootstrapRequestConflict("Maintenance runtime readiness exceeds its bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const value = MaintenanceRuntimeStatusSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  const { version: _version, nonce: observedNonce, ready, ...identity } = value;
  if (observedNonce !== nonce || !isDeepStrictEqual(identity, input.expected))
    throw new BootstrapRequestConflict(
      "Maintenance runtime readiness names a different native lifetime",
    );
  const observedAt = Date.now();
  const assertCurrent = () => {
    if (
      input.signal.aborted ||
      Date.now() - observedAt >= 5000 ||
      input.assertCurrent() !== undefined
    )
      throw new BootstrapRequestConflict("Maintenance runtime readiness changed");
  };
  assertCurrent();
  return { ready, assertCurrent };
}

const RuntimeDescriptorSchema = z.strictObject({
  version: z.literal(1),
  admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(),
  enrollmentSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  process: BootstrapProcessIdentitySchema,
  address: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
});

/** Resolve only the already verified native process's existing listener. The
 * descriptor cannot supply process identity, source authority or a new target. */
export async function readRegisteredMaintenanceRuntimeReadiness(input: {
  installationRoot: string;
  writableMountRoots: readonly string[];
  expected: MaintenanceRuntimeIdentity;
  signal: AbortSignal;
  assertCurrent(): void;
}) {
  BootstrapProcessIdentitySchema.parse(input.expected.process);
  const file = path.join(
    input.installationRoot,
    `maintenance-control-${input.expected.process.pid}.json`,
  );
  await assertBootstrapPathsProtected([file], input.writableMountRoots);
  const bytes = await readProtectedDocument(file);
  const descriptor = RuntimeDescriptorSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (!isDeepStrictEqual(descriptor.process, input.expected.process))
    throw new BootstrapRequestConflict("Maintenance listener belongs to another native lifetime");
  const before = lstatSync(file, { bigint: true });
  const assertCurrent = () => {
    const after = lstatSync(file, { bigint: true });
    if (
      realpathSync(file) !== file ||
      !after.isFile() ||
      after.nlink !== 1n ||
      ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"].some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
      ) ||
      input.assertCurrent() !== undefined
    )
      throw new BootstrapRequestConflict("Maintenance listener custody changed");
  };
  if (!(await readProtectedDocument(file)).equals(bytes))
    throw new BootstrapRequestConflict("Maintenance listener changed during loading");
  return readMaintenanceRuntimeReadiness({
    port: descriptor.port,
    expected: input.expected,
    signal: input.signal,
    assertCurrent,
  });
}
