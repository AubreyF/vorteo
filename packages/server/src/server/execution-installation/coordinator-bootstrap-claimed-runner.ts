import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  BootstrapClaimedRecoveryPlan,
  BootstrapClaimedRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  ClaimedReferenceSchema,
  ClaimedRunnerSetupSchema,
} from "./coordinator-bootstrap-claimed-launch.js";
import { FileClaimedRecoveryReviewJournal } from "./coordinator-bootstrap-claimed-journal.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  ClaimedRecoveryReviews,
  claimedRecoveryPlanDigest,
} from "./coordinator-bootstrap-claimed-recovery.js";
import {
  executeClaimedRecovery,
  reconcileClaimedRecovery,
} from "./coordinator-bootstrap-claimed-executor.js";
import { createClaimedNativeOperations } from "./coordinator-bootstrap-claimed-native.js";
import {
  verifySupportedClaimedRunner,
  verifyClaimedSelectedService,
  verifyClaimedPreparationIsolation,
  observeClaimedExecutor,
  verifyClaimedExecutionLock,
} from "./coordinator-bootstrap-claimed-verification.js";
import { verifyPreclaimRecoveryOwnership } from "./coordinator-bootstrap-preclaim-recovery.js";
import {
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
  inspectBootstrapWritableMountRoots,
  readBootstrapHostBinding,
} from "./coordinator-bootstrap-host.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import { verifyRetainedRenewal } from "./coordinator-bootstrap-renewal.js";
import {
  AuditedProcessObservationSchema,
  ProcessObservationSchema,
} from "./coordinator-bootstrap-process.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { InstallationConfigSchema } from "./config.js";

export async function retainClaimedExecutorBirth(input: {
  setupFile: string;
  recoveryDescriptor: number;
  writableMountRoots: readonly string[];
}) {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native recovery executor required");
  const setup = ClaimedRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  const identity = setup.request;
  if (
    input.setupFile !==
      path.join(
        setup.stateDirectory,
        `coordinator-claimed-launch-${identity.id}-${identity.revision}.json`,
      ) ||
    process.execPath !== setup.node.path ||
    process.argv[1] !== setup.entrypoint.path
  )
    throw new BootstrapRequestConflict("Recovery executor does not match its protected launch");
  const ownership = {
    stateDirectory: setup.stateDirectory,
    recoveryDescriptor: input.recoveryDescriptor,
    helper: setup.ownerLauncher,
    writableMountRoots: input.writableMountRoots,
  };
  await verifyPreclaimRecoveryOwnership(ownership);
  await readBootstrapPreparedFile(setup.entrypoint, input.writableMountRoots);
  const attemptFile = path.join(
    setup.stateDirectory,
    `coordinator-claimed-attempt-${identity.id}-${identity.revision}.json`,
  );
  const attempt = z
    .strictObject({
      version: z.literal(1),
      request: ClaimedReferenceSchema,
      setup: z.string(),
      launcherPid: z.number().int().positive(),
      attemptId: z.string().uuid(),
    })
    .parse(readPrivateBootstrapConfiguration(attemptFile, uid));
  if (
    !isDeepStrictEqual(attempt.request, identity) ||
    attempt.setup !== input.setupFile ||
    attempt.launcherPid !== process.pid
  )
    throw new BootstrapRequestConflict("Recovery launch attempt does not match this executor");
  const reviews = new FileClaimedRecoveryReviewJournal(setup.stateDirectory);
  const verifyReview = () => {
    const request = reviews.readReviews().find((item) => item.id === identity.id);
    if (
      !request ||
      request.revision !== identity.revision ||
      request.planSha256 !== identity.planSha256 ||
      request.status !== "approved" ||
      !request.decisionAt ||
      request.execution ||
      claimedRecoveryPlanDigest(request.plan) !== identity.planSha256 ||
      !isDeepStrictEqual(
        {
          id: request.plan.original.id,
          revision: request.plan.original.revision,
          planSha256: request.plan.original.planSha256,
        },
        setup.original,
      )
    )
      throw new BootstrapRequestConflict("Recovery approval changed before birth retention");
  };
  verifyReview();
  const reader = await createNativeBootstrapServiceReader({
    helperPath: setup.inspector.path,
    helperSha256: setup.inspector.sha256,
    writableMountRoots: input.writableMountRoots,
  });
  const executor = AuditedProcessObservationSchema.parse(
    await reader.inspectAuditedProcess(process.pid),
  );
  verifyClaimedBirthObservation(
    setup,
    input.setupFile,
    executor,
    ProcessObservationSchema.parse(await reader.inspectProcess(setup.renewal.hostProcess.pid)),
  );
  if (!isDeepStrictEqual(setup, readPrivateBootstrapConfiguration(input.setupFile, uid)))
    throw new BootstrapRequestConflict("Recovery launch snapshot changed before birth retention");
  const bytes = await readProtectedDocument(input.setupFile);
  if (!isDeepStrictEqual(ClaimedRunnerSetupSchema.parse(JSON.parse(bytes.toString("utf8"))), setup))
    throw new BootstrapRequestConflict("Recovery snapshot bytes changed before birth retention");
  const record = {
    version: 1,
    request: identity,
    attemptId: attempt.attemptId,
    setup: { path: input.setupFile, sha256: createHash("sha256").update(bytes).digest("hex") },
    executor,
  };
  const file = path.join(
    setup.stateDirectory,
    `coordinator-claimed-executor-${identity.id}-${identity.revision}.json`,
  );
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(setup.stateDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await verifyPreclaimRecoveryOwnership(ownership);
  verifyReview();
  if (!isDeepStrictEqual(executor, await reader.inspectAuditedProcess(process.pid)))
    throw new BootstrapRequestConflict("Recovery executor changed during birth retention");
  return record;
}

function verifyClaimedBirthObservation(
  setup: z.infer<typeof ClaimedRunnerSetupSchema>,
  setupFile: string,
  executor: z.infer<typeof AuditedProcessObservationSchema>,
  parent: z.infer<typeof AuditedProcessObservationSchema>["identity"],
) {
  const identity = setup.request;
  const argv = [
    setup.node.path,
    setup.entrypoint.path,
    setupFile,
    "claimed-executor",
    identity.id,
    identity.revision,
    identity.planSha256,
  ];
  const uid = process.getuid!();
  const host = setup.renewal.hostProcess;
  if (
    executor.identity.pid !== process.pid ||
    executor.identity.parentPid !== host.pid ||
    executor.identity.uid !== uid ||
    executor.identity.bootId !== host.bootId ||
    executor.identity.executable !== setup.node.path ||
    executor.identity.argumentsSha256 !==
      createHash("sha256").update(JSON.stringify(argv)).digest("hex") ||
    executor.auditToken[1] !== uid ||
    executor.auditToken[5] !== process.pid ||
    !isDeepStrictEqual(parent, host)
  )
    throw new BootstrapRequestConflict("Recovery executor birth or parent changed");
}

export async function runNativeClaimedRecovery(
  input: {
    setupFile: string;
    identity: z.infer<typeof ClaimedReferenceSchema>;
    recoveryDescriptor: number;
  },
  serviceReader?: Pick<
    Awaited<ReturnType<typeof createNativeBootstrapServiceReader>>,
    "readService"
  >,
  observationGeneration?: string,
): Promise<BootstrapClaimedRecoveryRequest> {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native recovery runner required");
  const setup = ClaimedRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  if (
    !observationGeneration &&
    !isDeepStrictEqual(ClaimedReferenceSchema.parse(input.identity), setup.request)
  )
    throw new BootstrapRequestConflict("Exact recovery runner approval required");
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(setup.renewal.originalAdmission, [])).toString("utf8"),
    ),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  await assertBootstrapPathsProtected([input.setupFile, setup.stateDirectory], roots);
  // Retain native birth before either runtime's expensive complete-tree digest.
  const birth = observationGeneration
    ? await verifyClaimedObserver(input, setup, observationGeneration, roots)
    : await retainClaimedExecutorBirth({ ...input, writableMountRoots: roots });
  await verifyRetainedRenewal(setup);
  const nativeReader = await createNativeBootstrapServiceReader({
    helperPath: setup.inspector.path,
    helperSha256: setup.inspector.sha256,
    writableMountRoots: roots,
  });
  // The fixed production entrypoint supplies no override. The narrow OS service
  // port lets disposable acceptance retain real audited processes and effects.
  const reader = serviceReader
    ? { ...nativeReader, readService: serviceReader.readService }
    : nativeReader;
  const journal = new FileClaimedRecoveryReviewJournal(setup.stateDirectory);
  const legacy = new FileBootstrapRequestJournal(setup.stateDirectory);
  const readBinding = () => {
    const current = readBootstrapHostBinding(setup.renewal.configuration.path, setup.daemonId);
    if (current.stateDirectory !== setup.stateDirectory)
      throw new BootstrapRequestConflict("Recovery state directory changed");
    return current.binding;
  };
  const verifyRuntime = async () => {
    await readBootstrapPreparedFile(birth.setup, roots);
    await verifyRetainedRenewal(setup, undefined, true);
    const config = InstallationConfigSchema.parse(
      readPrivateBootstrapConfiguration(setup.renewal.configuration.path, uid),
    );
    if (
      !config.sourceUpdates ||
      realpathSync(config.sourceUpdates.currentReleaseLink) !== setup.runtimeDirectory ||
      !isDeepStrictEqual(await inspectBootstrapWritableMountRoots(admission), roots)
    )
      throw new BootstrapRequestConflict("Recovery selected Host or mount boundaries changed");
  };
  const verifyTarget = async (plan: BootstrapClaimedRecoveryPlan) => {
    await verifyRuntime();
    assertClaimedRunnerTarget(setup, plan, journal, legacy);
    await verifySupportedClaimedRunner({
      plan,
      daemonId: setup.daemonId,
      admissionSetupFile: setup.admissionSetupFile,
      anchor: setup.renewal,
      writableMountRoots: roots,
    });
  };
  const context = {
    stateDirectory: setup.stateDirectory,
    recoveryDescriptor: input.recoveryDescriptor,
    helper: setup.ownerLauncher,
    inspector: setup.inspector,
    reader,
    launcherFile: setup.selectedLauncherFile,
    configurationFile: setup.renewal.configuration.path,
    writableMountRoots: roots,
    journal,
    verifySupportedPlan: verifyTarget,
  };
  const reviews = new ClaimedRecoveryReviews(journal, readBinding, async (plan) => {
    await verifyTarget(plan);
    await verifyClaimedSelectedService({ ...context, plan });
    await verifyClaimedExecutionLock({ ...context, plan });
    if ((await observeClaimedExecutor({ ...context, plan })) === "running")
      await verifyClaimedPreparationIsolation({ ...context, plan });
  });
  const native = createClaimedNativeOperations(context);
  if (observationGeneration) {
    return reconcileClaimedRecovery(
      reviews,
      journal,
      {
        ...input.identity,
        generation: observationGeneration,
      },
      {
        withOwnership: native.withOwnership,
        withVerifiedExitAndSelection: native.withVerifiedExitAndSelection,
      },
    );
  }
  return executeClaimedRecovery(reviews, journal, setup.request, native);
}

async function verifyClaimedObserver(
  input: {
    setupFile: string;
    identity: z.infer<typeof ClaimedReferenceSchema>;
    recoveryDescriptor: number;
  },
  setup: z.infer<typeof ClaimedRunnerSetupSchema>,
  generation: string,
  roots: readonly string[],
) {
  z.string().uuid().parse(generation);
  const journal = new FileClaimedRecoveryReviewJournal(setup.stateDirectory);
  const request = journal.readReviews().find((record) => record.id === input.identity.id);
  if (
    !request ||
    request.status !== "approved" ||
    request.revision !== input.identity.revision ||
    request.planSha256 !== input.identity.planSha256 ||
    request.execution?.generation !== generation ||
    setup.request.id !== request.id ||
    setup.request.planSha256 !== request.planSha256
  )
    throw new BootstrapRequestConflict("Exact retained claimed observation required");
  const uid = process.getuid!();
  const birthFile = path.join(
    setup.stateDirectory,
    `coordinator-claimed-executor-${request.id}-${setup.request.revision}.json`,
  );
  const birth = z
    .strictObject({
      version: z.literal(1),
      request: ClaimedReferenceSchema,
      attemptId: z.string().uuid(),
      setup: BootstrapRunnerSetupSchema.shape.entrypoint,
      executor: AuditedProcessObservationSchema,
    })
    .parse(readPrivateBootstrapConfiguration(birthFile, uid));
  const attempt = z
    .strictObject({
      version: z.literal(1),
      request: ClaimedReferenceSchema,
      setup: z.string(),
      launcherPid: z.number().int().positive(),
      attemptId: z.string().uuid(),
    })
    .parse(
      readPrivateBootstrapConfiguration(
        path.join(
          setup.stateDirectory,
          `coordinator-claimed-attempt-${request.id}-${setup.request.revision}.json`,
        ),
        uid,
      ),
    );
  const args = [
    setup.node.path,
    setup.entrypoint.path,
    input.setupFile,
    "claimed-observer",
    request.id,
    request.revision,
    request.planSha256,
    generation,
  ];
  if (
    !isDeepStrictEqual(birth.request, setup.request) ||
    !isDeepStrictEqual(attempt.request, setup.request) ||
    birth.setup.path !== input.setupFile ||
    attempt.setup !== input.setupFile ||
    attempt.attemptId !== birth.attemptId ||
    attempt.launcherPid !== birth.executor.identity.pid ||
    process.execPath !== setup.node.path ||
    !isDeepStrictEqual(process.argv, args)
  )
    throw new BootstrapRequestConflict("Claimed observation launch provenance changed");
  await readBootstrapPreparedFile(birth.setup, roots);
  await verifyPreclaimRecoveryOwnership({
    stateDirectory: setup.stateDirectory,
    recoveryDescriptor: input.recoveryDescriptor,
    helper: setup.ownerLauncher,
    writableMountRoots: roots,
  });
  const reader = await createNativeBootstrapServiceReader({
    helperPath: setup.inspector.path,
    helperSha256: setup.inspector.sha256,
    writableMountRoots: roots,
  });
  // Owning a released descriptor is not proof the previous runner exited.
  // An observer cannot retire that runner or replay any reserved effect.
  await reader.verifyProcessExited(birth.executor.identity.pid);
  return birth;
}

function assertClaimedRunnerTarget(
  setup: z.infer<typeof ClaimedRunnerSetupSchema>,
  plan: BootstrapClaimedRecoveryPlan,
  journal: FileClaimedRecoveryReviewJournal,
  original: FileBootstrapRequestJournal,
) {
  const reference = {
    id: plan.original.id,
    revision: plan.original.revision,
    planSha256: plan.original.planSha256,
  };
  if (
    !isDeepStrictEqual(reference, setup.original) ||
    !isDeepStrictEqual(setup.renewal.request, setup.original) ||
    plan.original.plan.state.directory !== setup.stateDirectory ||
    plan.selectedLauncher.path !== setup.selectedLauncherFile ||
    !isDeepStrictEqual(plan.selectedConfiguration, setup.renewal.configuration)
  )
    throw new BootstrapRequestConflict("Claimed recovery target differs from retained launch");
  const retained = journal.readReviews().find((record) => record.id === setup.request.id);
  if (
    !retained ||
    retained.status !== "approved" ||
    retained.planSha256 !== setup.request.planSha256 ||
    !isDeepStrictEqual(retained.plan, plan)
  )
    throw new BootstrapRequestConflict("Claimed recovery retained decision changed");
  const current = original.read().find((record) => record.id === plan.original.id);
  if (isDeepStrictEqual(current, plan.original)) {
    original.verifyUnpromotedClaim(plan.original);
    return;
  }
  // The old claim may differ only by the exact durable fence belonging to
  // this retained recovery. No substitute terminal or cancellation is admitted.
  journal.inspectEffects(retained);
}
