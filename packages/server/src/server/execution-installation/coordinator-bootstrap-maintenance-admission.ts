import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  assertBootstrapPathsProtected,
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
} from "./coordinator-bootstrap-artifact.js";
import { verifyBootstrapConfiguration } from "./coordinator-bootstrap-host.js";

const FileSchema = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Separate authority for an exact maintenance plan. A repair admission cannot
 * be reinterpreted as this operation, and this document is not dispatch approval. */
export const MaintenanceAdmissionSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("provision-coordinator-maintenance"),
  installationId: z.string().uuid(),
  requestId: z.string().uuid(),
  installationRecord: FileSchema,
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  hostSetupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.strictObject({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    directory: z.string().startsWith("/"),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    entrypoint: FileSchema,
    ownerLauncher: FileSchema,
    ownershipVerifier: FileSchema,
  }),
});

export function maintenanceHostSetupDigest(value: unknown): string {
  const setup = BootstrapRunnerSetupSchema.parse(value);
  if (!setup.renewal || setup.renewal.request || setup.maintenance)
    throw new BootstrapRequestConflict("Maintenance requires an undispatched Host snapshot");
  return createHash("sha256").update(JSON.stringify(setup)).digest("hex");
}

/** Structural binding only. Callers must verify protected files, full renewal
 * evidence and native identity before using this result, authenticate admission,
 * and obtain a separate exact owner decision before any lifecycle effect. */
export function inspectMaintenanceAdmission(input: {
  installationRoot: string;
  receipt: unknown;
  plan: unknown;
  hostSetup: unknown;
  runnerSetup: unknown;
}) {
  const receipt = MaintenanceAdmissionSchema.parse(input.receipt);
  const plan = CoordinatorBootstrapPlanSchema.parse(input.plan);
  const host = BootstrapRunnerSetupSchema.parse(input.hostSetup);
  const runner = BootstrapRunnerSetupSchema.parse(input.runnerSetup);
  const runtime = receipt.runtime;
  if (plan.bootRecovery && plan.bootRecovery.requestId !== receipt.requestId)
    throw new BootstrapRequestConflict("Maintenance boot recovery belongs to another review");
  if (
    receipt.installationRecord.path !== path.join(input.installationRoot, "installation.json") ||
    receipt.installationId !== plan.installationId ||
    receipt.planSha256 !== coordinatorPlanDigest(plan) ||
    receipt.hostSetupSha256 !== maintenanceHostSetupDigest(host) ||
    plan.state.directory !== path.join(input.installationRoot, "state/coordinator")
  )
    throw new BootstrapRequestConflict("Maintenance admission changed its installation or plan");

  const directory = path.join(input.installationRoot, "maintenance-runtimes", runtime.sourceCommit);
  if (
    runtime.directory !== directory ||
    runtime.entrypoint.path !==
      path.join(
        directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
      ) ||
    runtime.ownerLauncher.path !== path.join(directory, "scripts/run-coordinator-owner.py") ||
    runtime.ownershipVerifier.path !==
      path.join(directory, "scripts/verify-coordinator-owner.py") ||
    !isDeepStrictEqual(runner, {
      ...host,
      runtimeDirectory: runtime.directory,
      runtimeSha256: runtime.artifactSha256,
      entrypoint: runtime.entrypoint,
      ownerLauncher: runtime.ownerLauncher,
      ownershipVerifier: runtime.ownershipVerifier,
    })
  )
    throw new BootstrapRequestConflict("Maintenance runtime changed its admitted binding");

  assertMaintenanceReleaseScope(plan, receipt, host);
  return { receipt, plan, host, runner };
}

function assertMaintenanceReleaseScope(
  plan: z.infer<typeof CoordinatorBootstrapPlanSchema>,
  receipt: z.infer<typeof MaintenanceAdmissionSchema>,
  host: z.infer<typeof BootstrapRunnerSetupSchema>,
) {
  const runtime = receipt.runtime;
  const directory = runtime.directory;
  // Preserve the real selected Host provenance. The independent runtime does not
  // become that Host release merely because its reader is newer.
  if (plan.automaticRecovery !== "restore-compatible" || !plan.compatibleRecovery)
    throw new BootstrapRequestConflict("Maintenance requires compatible recovery");
  for (const release of [plan.candidate, plan.compatibleRecovery]) {
    if (
      release.sourceCommit !== runtime.sourceCommit ||
      release.directory !== runtime.directory ||
      release.artifactSha256 !== runtime.artifactSha256 ||
      !isDeepStrictEqual(release.node, host.node) ||
      release.entrypoint.path !==
        path.join(directory, "packages/server/dist/server/server/execution-installation/main.js")
    )
      throw new BootstrapRequestConflict("Maintenance candidate or recovery runtime changed");
  }
  if (
    plan.hostRequestsAfter !== null ||
    plan.nativeHelperConfiguration !== undefined ||
    plan.previewMonitorConfiguration !== undefined ||
    plan.claudeHostRefreshConfiguration !== undefined ||
    plan.factoryRuntimeAdoptionConfiguration !== undefined ||
    plan.sourceUpdateTooling !== undefined
  )
    throw new BootstrapRequestConflict(
      "Maintenance admission cannot include configuration changes",
    );
}

/** Inspect immutable proposal bytes, without authenticating or writing admission.
 * Native history/selection verification remains a separate mandatory boundary.
 * The receipt digest must come from the trusted controller launch, not its HTTP input. */
export async function verifyMaintenanceProposalFiles(input: {
  installationRoot: string;
  receiptFile: z.infer<typeof FileSchema>;
  plan: unknown;
  hostSetup: unknown;
  runnerSetup: unknown;
  writableMountRoots: readonly string[];
}) {
  const roots = input.writableMountRoots;
  const root = input.installationRoot;
  if ((await realpath(root)) !== root)
    throw new BootstrapRequestConflict("Maintenance root must be canonical");
  const expectedReceipt = path.join(
    root,
    "maintenance-admissions",
    input.receiptFile.sha256,
    "proposal.json",
  );
  if (input.receiptFile.path !== expectedReceipt)
    throw new BootstrapRequestConflict("Maintenance proposal escaped its exact namespace");
  for (const directory of [
    root,
    path.join(root, "maintenance-admissions"),
    path.dirname(expectedReceipt),
  ]) {
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory
    )
      throw new BootstrapRequestConflict(
        "Maintenance admission directory must be private and canonical",
      );
  }
  await assertBootstrapPathsProtected([root, expectedReceipt], roots);
  const bytes = await readBootstrapPreparedFile(input.receiptFile, roots);
  const context = inspectMaintenanceAdmission({
    ...input,
    receipt: JSON.parse(bytes.toString("utf8")),
  });
  if (
    createHash("sha256").update(JSON.stringify(context.receipt)).digest("hex") !==
    input.receiptFile.sha256
  )
    throw new BootstrapRequestConflict("Maintenance proposal is not canonical");
  const { receipt, plan, host } = context;
  const record = z
    .object({ root: z.string(), installationId: z.string().uuid(), coordinatorService: z.string() })
    .parse(
      JSON.parse(
        (await readBootstrapPreparedFile(receipt.installationRecord, roots)).toString("utf8"),
      ),
    );
  if (
    record.root !== root ||
    record.installationId !== plan.installationId ||
    record.coordinatorService !== plan.service
  )
    throw new BootstrapRequestConflict("Maintenance proposal selected another installation");
  if ((await realpath(receipt.runtime.directory)) !== receipt.runtime.directory)
    throw new BootstrapRequestConflict("Maintenance runtime must be canonical");
  await assertBootstrapPathsProtected([receipt.runtime.directory], roots);
  for (const file of [
    receipt.runtime.entrypoint,
    receipt.runtime.ownerLauncher,
    receipt.runtime.ownershipVerifier,
  ])
    await readBootstrapPreparedFile(file, roots);
  if ((await digestBootstrapArtifact(receipt.runtime.directory)) !== receipt.runtime.artifactSha256)
    throw new BootstrapRequestConflict("Maintenance runtime artifact changed");
  for (const release of [plan.previous, plan.candidate, plan.compatibleRecovery!])
    await verifyBootstrapReleaseArtifacts(release, roots);
  await readBootstrapPreparedFile(host.renewal!.configuration, roots);
  verifyBootstrapConfiguration({
    plan,
    configurationFile: host.renewal!.configuration.path,
    daemonId: host.daemonId,
  });
  // Long artifact walks cannot silently switch the reviewed proposal or root.
  await readBootstrapPreparedFile(receipt.installationRecord, roots);
  await readBootstrapPreparedFile(input.receiptFile, roots);
  return context;
}
