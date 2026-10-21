import { enrollmentNativeIdentityDigest } from "./maintenance/native-identity.js";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
  readPrivateBootstrapConfiguration,
  verifyBootstrapPlan,
} from "./coordinator-bootstrap-host.js";
import { deriveBootstrapRenewal, verifyRetainedRenewal } from "./coordinator-bootstrap-renewal.js";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import {
  maintenanceHostSetupDigest,
  verifyMaintenanceProposalFiles,
} from "./coordinator-bootstrap-maintenance-admission.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";

export interface MaintenanceProvisioningInput {
  /** Fixed by the trusted controller, never selected by a browser request. */
  installationRoot: string;
  admissionSha256: string;
  plan: unknown;
  hostSetup: unknown;
  runnerSetup: unknown;
}

/** Native read-only preparation. Independently observe the actual selected Host;
 * do not pretend the separate maintenance runtime is its selected release. */
export async function verifyNativeMaintenanceProposal(
  input: MaintenanceProvisioningInput,
  dispatchedRequest?: { id: string; revision: string; planSha256: string },
) {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Maintenance provisioning requires native Host validation");
  const digest = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.admissionSha256);
  const host = BootstrapRunnerSetupSchema.parse(input.hostSetup);
  const setupFile = path.join(input.installationRoot, "coordinator-bootstrap-runner.json");
  const original = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(setupFile, uid),
  );
  if (
    original.renewal ||
    original.daemonId !== host.daemonId ||
    original.admissionSetupFile !== host.admissionSetupFile
  )
    throw new BootstrapRequestConflict("Maintenance bootstrap anchor changed");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(original.admissionSetupFile, uid),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const proposal = await verifyMaintenanceProposalFiles({
    ...input,
    receiptFile: {
      path: path.join(input.installationRoot, "maintenance-admissions", digest, "proposal.json"),
      sha256: digest,
    },
    writableMountRoots: roots,
  });
  const configuration = z
    .object({ sourceUpdates: z.object({ currentReleaseLink: z.string().startsWith("/") }) })
    .parse(
      JSON.parse(
        (await readBootstrapPreparedFile(host.renewal!.configuration, roots)).toString("utf8"),
      ),
    );
  const selectedHost = await realpath(configuration.sourceUpdates.currentReleaseLink);
  if (dispatchedRequest && dispatchedRequest.id !== proposal.receipt.requestId)
    throw new BootstrapRequestConflict("Maintenance dispatch belongs to another admitted request");
  const dispatchRecord = dispatchedRequest
    ? verifyMaintenanceDispatchRecord(proposal.plan, dispatchedRequest)
    : undefined;
  const observed = await deriveBootstrapRenewal({
    setupFile,
    setup: original,
    moduleFile: path.join(
      selectedHost,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-launch.js",
    ),
    ...(dispatchedRequest ? { dispatchedRequest } : {}),
  });
  if (!observed || maintenanceHostSetupDigest(observed) !== proposal.receipt.hostSetupSha256)
    throw new BootstrapRequestConflict("Selected Host or retained maintenance history changed");
  await verifyRetainedRenewal(
    dispatchedRequest
      ? { ...observed, renewal: { ...observed.renewal!, request: dispatchedRequest } }
      : observed,
    dispatchRecord,
  );
  assertMaintenancePredecessor(proposal.plan.recoveredFrom, observed);
  await verifyBootstrapPlan(proposal.plan, {
    ...admission,
    daemonId: host.daemonId,
    configurationFile: host.renewal!.configuration.path,
  });
  if (
    !isDeepStrictEqual(
      original,
      BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid)),
    )
  )
    throw new BootstrapRequestConflict("Maintenance bootstrap anchor changed during validation");
  const finalRoots = await inspectBootstrapWritableMountRoots(admission);
  if (!isDeepStrictEqual(roots, finalRoots))
    throw new BootstrapRequestConflict("Maintenance writable mounts changed during validation");
  // All custody, launcher bytes, service registration and process checks above
  // precede this digest. The selected release and PID are intentionally excluded.
  const serviceSeparator = proposal.plan.service.lastIndexOf("/");
  const coordinatorIdentitySha256 = enrollmentNativeIdentityDigest({
    version: 1,
    environment: "host",
    target: "coordinator",
    installationId: proposal.receipt.installationId,
    custodyOwnerUid: uid,
    installationRoot: input.installationRoot,
    stateDirectory: proposal.plan.state.directory,
    serviceDomain: proposal.plan.service.slice(0, serviceSeparator),
    serviceLabel: proposal.plan.service.slice(serviceSeparator + 1),
    launcherPath: admission.launcherFile,
    selectionPath: null,
  });
  verifyEnrolledNativeIdentity(
    proposal.plan.state.directory,
    dispatchRecord?.enrollment?.grantId,
    coordinatorIdentitySha256,
  );
  return { ...proposal, writableMountRoots: roots, coordinatorIdentitySha256 };
}

/** The runner rechecks before and after claiming, while it owns the existing
 * native exclusion. Only its exact unpromoted claim may bridge those phases. */
export function verifyMaintenanceDispatchRecord(
  plan: z.infer<
    typeof import("@getpaseo/protocol/coordinator-bootstrap").CoordinatorBootstrapPlanSchema
  >,
  reference: { id: string; revision: string; planSha256: string },
) {
  const journal = new FileBootstrapRequestJournal(plan.state.directory);
  const retained = journal.read().find((entry) => entry.id === reference.id);
  if (
    !retained ||
    retained.status !== "approved" ||
    !retained.decisionAt ||
    retained.planSha256 !== reference.planSha256 ||
    !isDeepStrictEqual(retained.plan, plan) ||
    retained.automaticApproval ||
    retained.automaticSubmission
  )
    throw new BootstrapRequestConflict("Exact manual maintenance approval changed before dispatch");
  if (retained.execution) journal.verifyUnpromotedClaim(retained);
  else if (retained.revision !== reference.revision)
    throw new BootstrapRequestConflict("Maintenance approval revision changed before claim");
  return retained;
}

export function assertMaintenancePredecessor(
  recoveredFrom: unknown,
  host: z.infer<typeof BootstrapRunnerSetupSchema>,
) {
  const renewal = host.renewal;
  if (!renewal)
    throw new BootstrapRequestConflict("Maintenance requires retained renewal authority");
  const predecessor = renewal.unpromotedFailure ?? renewal.claimedRecovery?.original;
  if (!isDeepStrictEqual(recoveredFrom, predecessor))
    throw new BootstrapRequestConflict("Maintenance must retain the exact immediate predecessor");
}

function verifyEnrolledNativeIdentity(
  directory: string,
  grantId: string | undefined,
  identitySha256: string,
): void {
  if (!grantId) return;
  const enrollment = new FileEnrollmentJournal(directory).read();
  if (
    enrollment.status !== "enrolled" ||
    enrollment.grant.id !== grantId ||
    enrollment.grant.manifest.targets.find((target) => target.target === "coordinator")
      ?.identitySha256 !== identitySha256
  )
    throw new BootstrapRequestConflict("Native coordinator identity differs from enrollment");
}
