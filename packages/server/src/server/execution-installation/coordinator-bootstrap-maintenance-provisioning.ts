import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { compare } from "bcryptjs";
import {
  FileEnrollmentJournal,
  enrollmentManifestDigest,
  enrollInstallation,
  validateEnrollmentManifest,
} from "./maintenance/authorization.js";
import { z } from "zod";
import type { InstallationEnrollmentManifest } from "@getpaseo/protocol/installation-enrollment";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
} from "./coordinator-bootstrap.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import { inspectMaintenanceAdmission } from "./coordinator-bootstrap-maintenance-admission.js";
import {
  verifyNativeMaintenanceProposal,
  type MaintenanceProvisioningInput,
} from "./coordinator-bootstrap-maintenance-native.js";

/** Authentication admits only immutable review machinery. It never prepares a
 * lifecycle request, changes a selection, approves a plan or launches a runner. */
export async function provisionCoordinatorMaintenance(
  input: MaintenanceProvisioningInput & { ownerPassword: string },
) {
  const first = await verifyNativeMaintenanceProposal(input);
  await authenticateMaintenanceOwner(first, input.ownerPassword);
  const final = await verifyNativeMaintenanceProposal(input);
  if (!isDeepStrictEqual(first, final))
    throw new BootstrapRequestConflict("Maintenance proposal changed during owner authentication");
  await readBootstrapPreparedFile(final.host.renewal!.configuration, final.writableMountRoots);
  return persistMaintenanceAdmission(input, final);
}

async function authenticateMaintenanceOwner(
  first: Awaited<ReturnType<typeof verifyNativeMaintenanceProposal>>,
  ownerPassword: string,
) {
  const ownerBytes = await readBootstrapPreparedFile(
    first.host.renewal!.configuration,
    first.writableMountRoots,
  );
  const owner = z
    .object({
      public: z.object({ installationId: z.string().uuid() }),
      ownerPasswordHash: z.string().min(1),
    })
    .parse(JSON.parse(ownerBytes.toString("utf8")));
  if (
    owner.public.installationId !== first.receipt.installationId ||
    !(await compare(ownerPassword, owner.ownerPasswordHash))
  )
    throw new BootstrapAuthenticationRequired("Installation owner authentication required");
}

/** Called with a protected, fixed review by the independent controller. The
 * browser supplies only its exact decision reference and transient owner proof.
 * Durable consent is recorded before provisioning and survives a lost reply. */
export async function enrollAndProvisionCoordinatorMaintenance(
  input: MaintenanceProvisioningInput & {
    review: { id: string; revision: string; manifest: InstallationEnrollmentManifest };
    decision: { id: string; revision: string; manifestSha256: string };
    ownerPassword?: string;
  },
) {
  const manifest = validateEnrollmentManifest(input.review.manifest);
  const digest = enrollmentManifestDigest(manifest);
  if (
    input.review.revision !== manifest.revision ||
    input.decision.id !== input.review.id ||
    input.decision.revision !== input.review.revision ||
    input.decision.manifestSha256 !== digest ||
    manifest.provisioning?.admissionSha256 !== input.admissionSha256
  )
    throw new BootstrapRequestConflict("Exact enrollment review changed");
  const first = await verifyNativeMaintenanceProposal(input);
  if (
    manifest.targets.find((target) => target.target === "coordinator")?.identitySha256 !==
    first.coordinatorIdentitySha256
  )
    throw new BootstrapRequestConflict("Native coordinator identity differs from enrollment");
  if (manifest.installationId !== first.receipt.installationId)
    throw new BootstrapRequestConflict("Enrollment belongs to another installation");
  const step = manifest.steps.find((item) => item.id === manifest.provisioning?.coordinatorStepId);
  if (!matchesCoordinatorStep(step, first))
    throw new BootstrapRequestConflict("Enrollment coordinator step changed");
  const journal = new FileEnrollmentJournal(first.plan.state.directory);
  let state = journal.read();
  if (state.status === "absent") {
    if (!input.ownerPassword)
      throw new BootstrapAuthenticationRequired("Installation owner authentication required");
    await authenticateMaintenanceOwner(first, input.ownerPassword);
    const final = await verifyNativeMaintenanceProposal(input);
    if (!isDeepStrictEqual(first, final))
      throw new BootstrapRequestConflict("Enrollment context changed during authentication");
    await readBootstrapPreparedFile(final.host.renewal!.configuration, final.writableMountRoots);
    state = enrollInstallation(journal, {
      manifest,
      approval: {
        operation: "installation-enrollment",
        requestId: input.review.id,
        reviewRevision: input.review.revision,
        manifestSha256: digest,
        approvedAt: new Date().toISOString(),
      },
    });
  }
  if (
    state.status !== "enrolled" ||
    state.grant.approval.requestId !== input.review.id ||
    state.grant.approval.reviewRevision !== input.review.revision ||
    state.grant.approval.manifestSha256 !== digest ||
    !isDeepStrictEqual(state.grant.manifest, manifest)
  )
    throw new BootstrapRequestConflict("Retained enrollment differs from this decision");
  return provisionEnrolledCoordinatorMaintenance({
    ...input,
    grantId: state.grant.id,
    grantRevision: state.grant.revision,
  });
}

/** A retained enrollment is distinct from legacy provisioning and operation
 * approval. This prepares immutable machinery only; dispatch must separately
 * reserve and revalidate the exact enrolled activation step. */
export async function provisionEnrolledCoordinatorMaintenance(
  input: MaintenanceProvisioningInput & { grantId: string; grantRevision: string },
) {
  const first = await verifyNativeMaintenanceProposal(input);
  const journal = new FileEnrollmentJournal(first.plan.state.directory);
  const requireConsent = () => {
    const state = journal.read();
    if (state.status !== "enrolled")
      throw new BootstrapRequestConflict("Exact installation enrollment is required");
    const { grant, activation } = state;
    const binding = grant.manifest.provisioning;
    const step = grant.manifest.steps.find((item) => item.id === binding?.coordinatorStepId);
    const progress = activation.steps.find((item) => item.id === step?.id);
    if (
      grant.manifest.targets.find((target) => target.target === "coordinator")?.identitySha256 !==
        first.coordinatorIdentitySha256 ||
      grant.id !== input.grantId ||
      grant.revision !== input.grantRevision ||
      grant.paused ||
      grant.revokedAt ||
      grant.disabledTargets.includes("coordinator") ||
      grant.manifest.installationId !== first.receipt.installationId ||
      grant.approval.manifestSha256 !== enrollmentManifestDigest(grant.manifest) ||
      activation.manifestSha256 !== grant.approval.manifestSha256 ||
      binding?.admissionSha256 !== input.admissionSha256 ||
      step?.target !== "coordinator" ||
      step.operation !== "replacement" ||
      !matchesCoordinatorStep(step, first) ||
      progress?.status !== "pending"
    )
      throw new BootstrapRequestConflict("Enrollment no longer authorizes this provisioning");
    return {
      version: 1,
      grantId: grant.id,
      grantRevision: grant.revision,
      approval: grant.approval,
      stepId: step.id,
      admissionSha256: input.admissionSha256,
    };
  };
  const consent = requireConsent();
  const final = await verifyNativeMaintenanceProposal(input);
  if (!isDeepStrictEqual(first, final) || !isDeepStrictEqual(consent, requireConsent()))
    throw new BootstrapRequestConflict("Enrollment provisioning context changed");
  const result = await persistMaintenanceAdmission(input, final, requireConsent);
  const { writeRecoverySnapshot } = await import("./coordinator-bootstrap-launch.js");
  requireConsent();
  await writeRecoverySnapshot(
    path.join(
      input.installationRoot,
      "maintenance-admissions",
      input.admissionSha256,
      "enrollment.json",
    ),
    consent,
  );
  requireConsent();
  return { ...result, consent };
}

async function persistMaintenanceAdmission(
  input: MaintenanceProvisioningInput,
  final: Awaited<ReturnType<typeof verifyNativeMaintenanceProposal>>,
  requireConsent: () => unknown = () => undefined,
) {
  const directory = path.join(
    input.installationRoot,
    "maintenance-admissions",
    input.admissionSha256,
  );
  const { writeRecoverySnapshot } = await import("./coordinator-bootstrap-launch.js");
  // This content-addressed namespace never replaces the installed runner anchor.
  requireConsent();
  await writeRecoverySnapshot(path.join(directory, "plan.json"), final.plan);
  requireConsent();
  await writeRecoverySnapshot(path.join(directory, "host.json"), final.host);
  requireConsent();
  await writeRecoverySnapshot(path.join(directory, "runner.json"), final.runner);
  const admission = path.join(directory, "admission.json");
  requireConsent();
  await writeRecoverySnapshot(admission, final.receipt);
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await readBootstrapPreparedFile(
    { path: admission, sha256: input.admissionSha256 },
    final.writableMountRoots,
  );
  return {
    admission: { path: admission, sha256: input.admissionSha256 },
    provisioned: true,
    dispatched: false,
  };
}

/** Reopening an admitted controller observes the retained plan only. In
 * particular, a durable admission is neither an owner decision nor replay intent. */
export async function readProvisionedMaintenance(input: {
  installationRoot: string;
  admissionSha256: string;
}) {
  const digest = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.admissionSha256);
  const directory = path.join(input.installationRoot, "maintenance-admissions", digest);
  const admission = { path: path.join(directory, "admission.json"), sha256: digest };
  // Verify the independently supplied admission pin before reading its snapshots.
  const receiptBytes = await readBootstrapPreparedFile(admission, []);
  const names = ["plan.json", "host.json", "runner.json"];
  const snapshots = await Promise.all(
    names.map((name) => readProtectedDocument(path.join(directory, name))),
  );
  const prepared = {
    ...input,
    plan: JSON.parse(snapshots[0].toString("utf8")),
    hostSetup: JSON.parse(snapshots[1].toString("utf8")),
    runnerSetup: JSON.parse(snapshots[2].toString("utf8")),
  };
  inspectMaintenanceAdmission({ ...prepared, receipt: JSON.parse(receiptBytes.toString("utf8")) });
  const context = await verifyNativeMaintenanceProposal(prepared);
  await readBootstrapPreparedFile(admission, context.writableMountRoots);
  for (const [index, name] of names.entries()) {
    if (!(await readProtectedDocument(path.join(directory, name))).equals(snapshots[index]))
      throw new BootstrapRequestConflict("Maintenance snapshot changed during reopening");
  }
  return { ...context, admission };
}

function matchesCoordinatorStep(
  step: InstallationEnrollmentManifest["steps"][number] | undefined,
  proposal: Awaited<ReturnType<typeof verifyNativeMaintenanceProposal>>,
): boolean {
  return (
    step !== undefined &&
    step.planSha256 === proposal.receipt.planSha256 &&
    isDeepStrictEqual(step.candidate, {
      sourceCommit: proposal.receipt.runtime.sourceCommit,
      artifactSha256: proposal.receipt.runtime.artifactSha256,
    }) &&
    isDeepStrictEqual(step.previous, {
      sourceCommit: proposal.plan.previous.sourceCommit,
      artifactSha256: proposal.plan.previous.artifactSha256,
    })
  );
}
