import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import {
  FileEnrollmentJournal,
  enrollmentManifestDigest,
  observeActivationStep,
} from "./maintenance/authorization.js";

/** Observation has no process, selection, approval or dispatch ports. Its native
 * verifier must establish candidate identity/readiness and retained state before
 * this function settles the exact existing activation generation. */
export async function observeEnrolledCoordinator(input: {
  directory: string;
  requestId: string;
  verify(request: CoordinatorBootstrapRequest): Promise<void>;
}) {
  const requests = new FileBootstrapRequestJournal(input.directory);
  const journal = new FileEnrollmentJournal(input.directory);
  const request = requests.read().find((item) => item.id === input.requestId);
  if (
    !request?.enrollment ||
    !request.enrollmentDispatch ||
    request.plan.state.directory !== input.directory ||
    request.execution?.stage !== "succeeded"
  )
    throw new BootstrapRequestConflict(
      "Enrolled coordinator has no completed execution to observe",
    );
  const proof = request.enrollment;
  const state = journal.read();
  if (state.status !== "enrolled") throw new BootstrapRequestConflict("Enrollment is absent");
  assertObservationBinding(request, state);
  await input.verify(request);
  // Native observation cannot settle a changed request or a different generation.
  if (
    !isDeepStrictEqual(
      requests.read().find((item) => item.id === request.id),
      request,
    )
  )
    throw new BootstrapRequestConflict("Coordinator execution changed during observation");
  const receipt = {
    version: 1,
    requestId: request.id,
    revision: request.revision,
    planSha256: request.planSha256,
    execution: request.execution,
    enrollment: proof,
  };
  const observationSha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  return observeActivationStep(journal, {
    stepId: proof.stepId,
    generation: proof.generation,
    outcome: "succeeded",
    observationSha256,
  });
}

function assertObservationBinding(
  request: CoordinatorBootstrapRequest,
  state: Extract<ReturnType<FileEnrollmentJournal["read"]>, { status: "enrolled" }>,
) {
  const proof = request.enrollment!;
  const { grant, activation } = state;
  const step = grant.manifest.steps.find((item) => item.id === proof.stepId);
  const progress = activation.steps.find((item) => item.id === proof.stepId);
  const artifact = (release: { sourceCommit: string; artifactSha256: string }) => ({
    sourceCommit: release.sourceCommit,
    artifactSha256: release.artifactSha256,
  });
  if (
    grant.id !== proof.grantId ||
    grant.approval.requestId !== proof.reviewId ||
    grant.approval.reviewRevision !== proof.reviewRevision ||
    enrollmentManifestDigest(grant.manifest) !== proof.manifestSha256 ||
    grant.manifest.provisioning?.admissionSha256 !== proof.admissionSha256 ||
    grant.manifest.provisioning.coordinatorStepId !== proof.stepId ||
    step?.target !== "coordinator" ||
    step.operation !== "replacement" ||
    step.planSha256 !== request.planSha256 ||
    coordinatorPlanDigest(request.plan) !== request.planSha256 ||
    !isDeepStrictEqual(step.candidate, artifact(request.plan.candidate)) ||
    !isDeepStrictEqual(step.previous, artifact(request.plan.previous)) ||
    !progress ||
    progress.status === "pending" ||
    progress.generation !== proof.generation ||
    progress.grantRevision !== proof.grantRevision
  )
    throw new BootstrapRequestConflict(
      "Enrollment observation differs from its retained execution",
    );
}

/** Native observer uses only admitted fixed paths and read-only service ports.
 * It never constructs a lifecycle executor or reacquires execution ownership. */
export async function verifyEnrolledCoordinatorCandidate(
  setup: import("zod").z.infer<
    typeof import("./coordinator-bootstrap-runner.js").BootstrapRunnerSetupSchema
  >,
  request: CoordinatorBootstrapRequest,
) {
  const { verifyMaintenanceRunnerPlan } =
    await import("./coordinator-bootstrap-maintenance-runtime.js");
  const {
    BootstrapAdmissionSetupSchema,
    inspectBootstrapWritableMountRoots,
    readPrivateBootstrapConfiguration,
  } = await import("./coordinator-bootstrap-host.js");
  const { readBootstrapPreparedFile, verifyBootstrapReleaseArtifacts } =
    await import("./coordinator-bootstrap-artifact.js");
  const { createNativeBootstrapServiceReader } = await import("./coordinator-bootstrap-service.js");
  const { readBootstrapHealth } = await import("./coordinator-bootstrap-runtime.js");
  const { verifyCompletedBootstrapState } = await import("./coordinator-bootstrap-state.js");
  const { InstallationConfigSchema } = await import("./config.js");
  if (!request.execution || request.execution.stage !== "succeeded")
    throw new BootstrapRequestConflict("Completed coordinator execution required");
  await verifyMaintenanceRunnerPlan(setup, request.plan);
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, process.getuid!()),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const config = InstallationConfigSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(request.plan.candidate.configuration, roots)).toString(
        "utf8",
      ),
    ),
  );
  if (
    config.public.installationId !== request.plan.installationId ||
    config.stateDir !== request.plan.state.directory
  )
    throw new BootstrapRequestConflict("Observed coordinator configuration changed");
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  await reader.verifyProcessExited(request.plan.expectedProcess.pid);
  await verifyBootstrapReleaseArtifacts(request.plan.candidate, roots);
  await verifyCompletedMaintenanceCandidate(request, reader, () =>
    readBootstrapHealth(config.listenPort),
  );
  await readBootstrapPreparedFile(
    { path: admission.launcherFile, sha256: request.plan.candidate.launcher.sha256 },
    roots,
  );
  await verifyCompletedBootstrapState({ request, writableMountRoots: roots });
  await verifyBootstrapReleaseArtifacts(request.plan.candidate, roots);
  if (!isDeepStrictEqual(roots, await inspectBootstrapWritableMountRoots(admission)))
    throw new BootstrapRequestConflict("Observed coordinator mounts changed");
}

/** A completed coordinator serves ordinary health, not the pre-release fenced
 * response. Keep that distinction local to observation; dispatch verification
 * must still require the exact startup generation. */
export async function verifyCompletedMaintenanceCandidate(
  request: CoordinatorBootstrapRequest,
  reader: import("./coordinator-bootstrap-service.js").BootstrapServiceReader,
  readHealth: () => Promise<unknown>,
) {
  const { loadedCoordinatorPid } = await import("./coordinator-bootstrap-service.js");
  const { ProcessObservationSchema } = await import("./coordinator-bootstrap-process.js");
  const { z } = await import("zod");
  if (request.execution?.stage !== "succeeded")
    throw new BootstrapRequestConflict("Completed execution required");
  const expectedArguments = createHash("sha256")
    .update(
      JSON.stringify([
        request.plan.candidate.node.path,
        request.plan.candidate.entrypoint.path,
        request.plan.candidate.configuration.path,
      ]),
    )
    .digest("hex");
  let first: ReturnType<typeof ProcessObservationSchema.parse> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const pid = loadedCoordinatorPid(
      request.plan.service,
      await reader.readService(request.plan.service),
    );
    const observed = ProcessObservationSchema.parse(await reader.inspectProcess(pid));
    if (
      pid === request.plan.expectedProcess.pid ||
      observed.pid !== pid ||
      observed.parentPid !== 1 ||
      observed.uid !== process.getuid!() ||
      observed.bootId !== request.plan.expectedProcess.bootId ||
      observed.executable !== request.plan.candidate.node.path ||
      observed.argumentsSha256 !== expectedArguments ||
      (first && !isDeepStrictEqual(first, observed))
    )
      throw new BootstrapRequestConflict("Completed coordinator native identity changed");
    first = observed;
    z.strictObject({ installationId: z.literal(request.plan.installationId) }).parse(
      await readHealth(),
    );
    if (
      !isDeepStrictEqual(observed, await reader.inspectProcess(pid)) ||
      loadedCoordinatorPid(request.plan.service, await reader.readService(request.plan.service)) !==
        pid
    )
      throw new BootstrapRequestConflict("Completed coordinator changed during observation");
  }
}
