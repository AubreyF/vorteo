import { compare } from "bcryptjs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  BootstrapPreclaimRecoveryPlanSchema,
  BootstrapPreclaimRecoveryPreparationSchema,
  BootstrapPreclaimRecoveryRequestSchema,
  BootstrapProcessIdentitySchema,
  type BootstrapPreclaimRecoveryPlan,
  type BootstrapPreclaimRecoveryRequest,
  CoordinatorBootstrapRequestSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { AuditedProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import {
  loadedCoordinatorPid,
  verifyLoadedBootstrapService,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import {
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
  verifyBootstrapReleaseArtifacts,
} from "./coordinator-bootstrap-artifact.js";

import {
  BootstrapRequestConflict,
  BootstrapAuthenticationRequired,
  type BootstrapHostBinding,
  coordinatorPlanDigest,
} from "./coordinator-bootstrap.js";

/** Use before effects and again under terminal kernel ownership. Host setup
 * supplies the selected paths; a review cannot substitute an unchanged copy. */
export async function verifyPreclaimSelectedService(input: {
  plan: BootstrapPreclaimRecoveryPlan;
  reader: Pick<NativeBootstrapServiceReader, "inspectProcess" | "readService">;
  launcherFile: string;
  configurationFile: string;
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validatePreclaimRecoveryPlan(input.plan);
  if (
    plan.selectedLauncher.path !== input.launcherFile ||
    plan.selectedConfiguration.path !== input.configurationFile
  )
    throw new BootstrapRequestConflict("Preclaim recovery selected paths changed");
  for (let observation = 0; observation < 2; observation++) {
    await readBootstrapPreparedFile(plan.selectedLauncher, input.writableMountRoots);
    await readBootstrapPreparedFile(plan.selectedConfiguration, input.writableMountRoots);
    await verifyLoadedBootstrapService({
      plan: plan.original.plan,
      hostUid: plan.coordinatorProcess.uid,
      configurationFile: input.configurationFile,
      reader: input.reader,
    });
    if (
      !isDeepStrictEqual(
        await input.reader.inspectProcess(plan.coordinatorProcess.pid),
        plan.coordinatorProcess,
      )
    )
      throw new BootstrapRequestConflict("Preclaim recovery coordinator identity changed");
  }
  // The final native observation can overlap a file replacement. Recheck bytes
  // before returning to the caller that still owns the execution lock.
  await readBootstrapPreparedFile(plan.selectedLauncher, input.writableMountRoots);
  await readBootstrapPreparedFile(plan.selectedConfiguration, input.writableMountRoots);
}

/** This is one part of terminal verification, never a success receipt itself.
 * The managed recovery runner supplies descriptor and helper, not an RPC caller. */
export async function withPreclaimKernelOwnership<T>(input: {
  request: BootstrapPreclaimRecoveryRequest;
  recoveryDescriptor: number;
  helper: BootstrapPreclaimRecoveryPlan["ownerLauncher"];
  writableMountRoots: readonly string[];
  operation(): Promise<T>;
}): Promise<T> {
  const request = BootstrapPreclaimRecoveryRequestSchema.parse(input.request);
  validatePreclaimRecoveryPlan(request.plan);
  if (
    process.platform !== "darwin" ||
    request.status !== "approved" ||
    request.execution?.stage !== "verifying" ||
    request.planSha256 !== preclaimRecoveryPlanDigest(request.plan) ||
    !Number.isSafeInteger(input.recoveryDescriptor) ||
    input.recoveryDescriptor < 3
  )
    throw new BootstrapRequestConflict("Exact native recovery verification required");
  const source = await readBootstrapPreparedFile(input.helper, input.writableMountRoots);
  const handle = await open(
    request.plan.executionLock.path,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let diagnostic = "";
      const failed = () => {
        const known =
          /^preclaim:(review_changed|cancellation_unproven|execution_lock_changed|executor_exit_unproven|children_unproven|verification_failed)\n$/.exec(
            diagnostic,
          );
        const reason = known?.[1] ?? "verification_failed";
        reject(new BootstrapRequestConflict(`Preclaim native verification refused: ${reason}`));
      };
      const child = spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          source.toString("utf8"),
          "preclaim-verify",
          request.plan.original.plan.state.directory,
          request.id,
          request.revision,
          request.execution!.generation,
          request.planSha256,
        ],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "ignore", "pipe", input.recoveryDescriptor, handle.fd],
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      child.stderr!.on("data", (bytes: Buffer) => {
        diagnostic = (diagnostic + bytes.toString("utf8")).slice(0, 256);
      });
      child.once("error", failed);
      child.once("close", (code) => (code === 0 ? resolve() : failed()));
    });
    // flock belongs to the inherited open file description. Keeping our handle
    // open retains ownership after the verifier exits and through receipt commit.
    return await input.operation();
  } finally {
    await handle.close();
  }
}

/** Retain the actual execution lock through selection checks and receipt commit.
 * This composes exit/ownership/selection only; the runner must also establish
 * its descendant invariant before treating the callback as terminal recovery. */
export async function withPreclaimTerminalSelection<T>(input: {
  request: BootstrapPreclaimRecoveryRequest;
  recoveryDescriptor: number;
  helper: BootstrapPreclaimRecoveryPlan["ownerLauncher"];
  writableMountRoots: readonly string[];
  reader: Pick<
    NativeBootstrapServiceReader,
    "inspectProcess" | "readService" | "verifyProcessExited"
  >;
  launcherFile: string;
  configurationFile: string;
  operation(): Promise<T>;
}): Promise<T> {
  const request = BootstrapPreclaimRecoveryRequestSchema.parse(input.request);
  return withPreclaimKernelOwnership({
    ...input,
    request,
    operation: async () => {
      await verifyPreclaimSelectedService({ ...input, plan: request.plan });
      await input.reader.verifyProcessExited(request.plan.executor.identity.pid);
      return input.operation();
    },
  });
}

/** Internal durable evidence, never owner authorization by itself. A managed
 * review must authenticate this exact binding before the journal accepts it. */
export const PreclaimCancellationSchema = z.strictObject({
  version: z.literal(1),
  recoveryId: z.string().uuid(),
  recoveryRevision: z.string().uuid(),
  recoveryGeneration: z.string().uuid(),
  recoveryPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  original: CoordinatorBootstrapRequestSchema,
  canceled: CoordinatorBootstrapRequestSchema,
  executor: AuditedProcessObservationSchema,
  ownerCancellation: CoordinatorBootstrapRequestSchema.optional(),
});
export type PreclaimCancellation = z.infer<typeof PreclaimCancellationSchema>;

export const PreclaimRecoveryRecordSchema = z.strictObject({
  cancellation: PreclaimCancellationSchema,
  fenced: z.boolean(),
  // An intent consumes the slot even when the native result is lost. Never
  // infer that a signal was not sent from a missing completion notification.
  terminateIntentAt: z.string().datetime().nullable(),
  killIntentAt: z.string().datetime().nullable(),
});
export type PreclaimRecoveryRecord = z.infer<typeof PreclaimRecoveryRecordSchema>;

export function validatePreclaimCancellation(value: unknown): PreclaimCancellation {
  const input = PreclaimCancellationSchema.parse(value);
  if (input.recoveryId === input.original.id || input.canceled.decisionAt === undefined)
    throw new BootstrapRequestConflict("Preclaim recovery cancellation binding changed");
  validateCancellationTransition(input);
  if (input.ownerCancellation && !isDeepStrictEqual(input.ownerCancellation, input.canceled))
    throw new BootstrapRequestConflict("Retained owner cancellation changed");
  return input;
}

function validateCancellationTransition(
  input: Pick<PreclaimCancellation, "original" | "canceled" | "executor">,
): void {
  const { original, canceled, executor } = input;
  const { decisionAt: originalDecisionAt, ...originalFields } = original;
  const { decisionAt: canceledDecisionAt, ...canceledFields } = canceled;
  const expected = {
    ...originalFields,
    revision: canceled.revision,
    status: "canceled",
  };
  const validTransition =
    original.status === "approved" &&
    original.execution === undefined &&
    originalDecisionAt !== undefined &&
    (canceledDecisionAt === undefined ||
      Date.parse(canceledDecisionAt) >= Date.parse(originalDecisionAt)) &&
    canceled.revision !== original.revision &&
    isDeepStrictEqual(canceledFields, expected);
  const validIdentity =
    executor.identity.pid !== original.plan.expectedProcess.pid &&
    executor.identity.uid === executor.auditToken[1] &&
    executor.identity.pid === executor.auditToken[5];
  if (
    !validTransition ||
    !validIdentity ||
    original.planSha256 !== coordinatorPlanDigest(original.plan)
  )
    throw new BootstrapRequestConflict("Preclaim recovery cancellation binding changed");
}

export function preclaimRecoveryPlanDigest(plan: BootstrapPreclaimRecoveryPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(BootstrapPreclaimRecoveryPlanSchema.parse(plan)))
    .digest("hex");
}

function validateRetainedOwnerCancellation(plan: BootstrapPreclaimRecoveryPlan): void {
  if (Boolean(plan.ownerCancellation) !== Boolean(plan.originalApproval))
    throw new BootstrapRequestConflict(
      "Retained original approval and owner cancellation required together",
    );
  if (plan.ownerCancellation) {
    if (
      !plan.ownerCancellation.decisionAt ||
      !isDeepStrictEqual(plan.ownerCancellation, {
        ...plan.canceled,
        decisionAt: plan.ownerCancellation.decisionAt,
      })
    )
      throw new BootstrapRequestConflict("Retained owner cancellation changed");
    validateCancellationTransition({ ...plan, canceled: plan.ownerCancellation });
  }
}

/** Structural admission is separate from native verification. The dispatcher
 * must reread protected bytes, journal state and audited processes before effects. */
export function validatePreclaimRecoveryPlan(value: unknown): BootstrapPreclaimRecoveryPlan {
  const plan = BootstrapPreclaimRecoveryPlanSchema.parse(value);
  if (plan.canceled.decisionAt !== undefined)
    throw new BootstrapRequestConflict(
      "Cancellation time must come from the recovery owner decision",
    );
  validateCancellationTransition(plan);
  validateRetainedOwnerCancellation(plan);
  const executor = plan.executor.identity;
  const original = plan.original;
  const expectedCoordinator = original.plan.expectedProcess;
  const argumentsSha256 = createHash("sha256")
    .update(
      JSON.stringify([
        plan.runner.node.path,
        plan.executorEntrypoint.path,
        plan.setup.path,
        "executor",
        original.id,
      ]),
    )
    .digest("hex");
  const hostMatches =
    executor.parentPid === plan.hostProcess.pid &&
    executor.uid === plan.hostProcess.uid &&
    executor.bootId === plan.hostProcess.bootId;
  const coordinatorMatches =
    plan.coordinatorProcess.pid === expectedCoordinator.pid &&
    plan.coordinatorProcess.bootId === expectedCoordinator.bootId &&
    plan.coordinatorProcess.startIdentity === expectedCoordinator.startIdentity &&
    plan.coordinatorProcess.argumentsSha256 === expectedCoordinator.argumentsSha256 &&
    plan.coordinatorProcess.executable === original.plan.previous.node.path &&
    plan.coordinatorProcess.uid === executor.uid &&
    plan.coordinatorProcess.bootId === executor.bootId;
  const runnerMatches =
    isDeepStrictEqual(plan.runner, original.plan.candidate) &&
    plan.executorEntrypoint.path ===
      path.join(
        plan.runner.directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
      ) &&
    executor.executable === plan.runner.node.path &&
    executor.argumentsSha256 === argumentsSha256;
  const selectionMatches =
    plan.selectedLauncher.sha256 === original.plan.previous.launcher.sha256 &&
    plan.selectedConfiguration.sha256 === original.plan.previous.configuration.sha256 &&
    plan.executionLock.path ===
      path.join(original.plan.state.directory, "coordinator-bootstrap-execution.lock");
  if (!hostMatches || !coordinatorMatches || !runnerMatches || !selectionMatches)
    throw new BootstrapRequestConflict("Preclaim recovery native binding changed");
  return plan;
}

// COMPAT(preclaimRecovery): v320's reviewed runner claims the legacy journal
// before it arms its detached watchdog or performs lifecycle effects. Support
// this known source explicitly; an unfamiliar runner needs its own review.
const legacyPreclaimSource = "853b193e69c48260366635610501912efff73a0c";
const legacyPreclaimFiles = {
  "coordinator-bootstrap-runner.js":
    "8859a4f24c3c228ce3beba1c4a2cef69c0b2b931430fc52e4dfb5a628b744d28",
  "coordinator-bootstrap-executor.js":
    "56abd8be342c1181df1ac4cf4fa0057814b6203842d1188c088ab8349444e802",
  "coordinator-bootstrap.js": "3a5bca2374f52c9152ef4a8af8d54b006177c72bb08896191d1772950e711847",
  "coordinator-bootstrap-journal.js":
    "a11341897674d5eb2bf6bbd7d0a8c96305a5cb11fecc25ae6db9cbd9d0a3ce91",
};
const legacyPreclaimOwner = "c7022f08433113bc66f72cdec2ca9f7f9142decb4fa790e4d183099f06cc42c4";

/** The canceled journal no longer contains the old approval. Retain its full
 * protected bytes and bind them to the old setup and audited observation below. */
export async function verifyPreclaimOriginalApproval(
  plan: BootstrapPreclaimRecoveryPlan,
  writableMountRoots: readonly string[],
): Promise<void> {
  validatePreclaimRecoveryPlan(plan);
  if (!plan.originalApproval) return;
  const bytes = await readBootstrapPreparedFile(plan.originalApproval, writableMountRoots);
  const original = CoordinatorBootstrapRequestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (!isDeepStrictEqual(original, plan.original))
    throw new BootstrapRequestConflict("Retained original approval changed");
}

/** Verify the reviewed preclaim control flow and its original protected setup.
 * This grants no process authority. Admission must also observe the exact live
 * audited process and isolated group; execution still needs the new approval. */
export async function verifySupportedPreclaimRunner(input: {
  plan: BootstrapPreclaimRecoveryPlan;
  daemonId: string;
  admissionSetupFile: string;
  anchor: {
    originalSetup: BootstrapPreclaimRecoveryPlan["setup"];
    originalAdmission: BootstrapPreclaimRecoveryPlan["setup"];
    terminal: { id: string; revision: string; generation: string; planSha256: string };
  };
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validatePreclaimRecoveryPlan(input.plan);
  await verifyPreclaimOriginalApproval(plan, input.writableMountRoots);
  if (plan.runner.sourceCommit !== legacyPreclaimSource || !plan.retainedObservation)
    throw new BootstrapRequestConflict(
      "Target runner release is not supported for preclaim recovery",
    );
  const directory = path.join(
    plan.runner.directory,
    "packages/server/dist/server/server/execution-installation",
  );
  for (const [name, sha256] of Object.entries(legacyPreclaimFiles))
    await readBootstrapPreparedFile(
      { path: path.join(directory, name), sha256 },
      input.writableMountRoots,
    );
  const owner = {
    path: path.join(plan.runner.directory, "scripts/run-coordinator-owner.py"),
    sha256: legacyPreclaimOwner,
  };
  if (!isDeepStrictEqual(plan.ownerLauncher, owner))
    throw new BootstrapRequestConflict("Target runner ownership launcher is not supported");
  await readBootstrapPreparedFile(owner, input.writableMountRoots);
  const { BootstrapRunnerSetupSchema } = await import("./coordinator-bootstrap-runner.js");
  const setup = BootstrapRunnerSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(plan.setup, input.writableMountRoots)).toString("utf8"),
    ),
  );
  const expected = {
    daemonId: input.daemonId,
    admissionSetupFile: input.admissionSetupFile,
    node: plan.runner.node,
    entrypoint: plan.executorEntrypoint,
    ownerLauncher: plan.ownerLauncher,
    runtimeDirectory: plan.runner.directory,
    runtimeSha256: plan.runner.artifactSha256,
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[])
    if (!isDeepStrictEqual(setup[key], expected[key]))
      throw new BootstrapRequestConflict("Target runner setup differs from its reviewed runtime");
  const renewal = setup.renewal;
  if (
    !renewal ||
    !isDeepStrictEqual(renewal.originalSetup, input.anchor.originalSetup) ||
    !isDeepStrictEqual(renewal.originalAdmission, input.anchor.originalAdmission) ||
    !isDeepStrictEqual(renewal.terminal, input.anchor.terminal) ||
    !isDeepStrictEqual(renewal.hostProcess, plan.hostProcess) ||
    !isDeepStrictEqual(renewal.configuration, plan.selectedConfiguration) ||
    !isDeepStrictEqual(renewal.request, {
      id: plan.original.id,
      revision: plan.original.revision,
      planSha256: plan.original.planSha256,
    }) ||
    renewal.sourceCommit !== plan.runner.sourceCommit
  )
    throw new BootstrapRequestConflict("Target runner renewal provenance changed");
  for (const file of [renewal.originalSetup, renewal.originalAdmission, renewal.source])
    await readBootstrapPreparedFile(file, input.writableMountRoots);
  await verifyBootstrapReleaseArtifacts(plan.runner, input.writableMountRoots);
}

/** Checks the live native identities, not artifact integrity or authorization.
 * Repeat the observations around the service lookup so a changed parent,
 * executable or audit generation never becomes evidence for an effect. */
export async function verifyPreclaimLiveProcesses(input: {
  plan: BootstrapPreclaimRecoveryPlan;
  reader: Pick<
    NativeBootstrapServiceReader,
    "inspectProcess" | "inspectAuditedProcess" | "readService" | "verifyProcessExited"
  >;
  retainedContext?: {
    inspector: BootstrapPreclaimRecoveryPlan["setup"];
    writableMountRoots: readonly string[];
  };
}): Promise<void> {
  const { plan, reader } = input;
  validatePreclaimRecoveryPlan(plan);
  if (plan.retainedObservation) {
    if (!input.retainedContext)
      throw new BootstrapRequestConflict("Protected retained observation context required");
    await verifyRetainedPreclaimObservation(plan, input.retainedContext);
  }
  for (let observation = 0; observation < 2; observation++) {
    const coordinator = await reader.inspectProcess(plan.coordinatorProcess.pid);
    const executor = await reader.inspectAuditedProcess(plan.executor.identity.pid);
    // Parent death changes PPID, not the retained birth or audit identity.
    // Only a separately reviewed protected observation permits that one change.
    const reparented = plan.retainedObservation !== undefined && executor.identity.parentPid === 1;
    const expectedExecutor = structuredClone(plan.executor);
    if (reparented) {
      await reader.verifyProcessExited(plan.hostProcess.pid);
      expectedExecutor.identity.parentPid = 1;
    } else {
      const host = await reader.inspectProcess(plan.hostProcess.pid);
      if (!isDeepStrictEqual(host, plan.hostProcess))
        throw new BootstrapRequestConflict("Preclaim recovery process identity changed");
    }
    if (
      !isDeepStrictEqual(coordinator, plan.coordinatorProcess) ||
      !isDeepStrictEqual(executor, expectedExecutor)
    )
      throw new BootstrapRequestConflict("Preclaim recovery process identity changed");
    const selected = loadedCoordinatorPid(
      plan.original.plan.service,
      await reader.readService(plan.original.plan.service),
    );
    if (selected !== plan.coordinatorProcess.pid)
      throw new BootstrapRequestConflict("Preclaim recovery selected coordinator changed");
  }
}

/** Preparation proves isolation around two audited observations. Supported
 * runner provenance separately establishes no detached work before claim. */
export async function verifyPreclaimPreparationIsolation(input: {
  plan: BootstrapPreclaimRecoveryPlan;
  reader: Parameters<typeof verifyPreclaimLiveProcesses>[0]["reader"];
  helper: BootstrapPreclaimRecoveryPlan["ownerLauncher"];
  inspector: BootstrapPreclaimRecoveryPlan["setup"];
  writableMountRoots: readonly string[];
}): Promise<void> {
  const plan = validatePreclaimRecoveryPlan(input.plan);
  const verify = () =>
    verifyPreclaimLiveProcesses({
      plan,
      reader: input.reader,
      retainedContext: { inspector: input.inspector, writableMountRoots: input.writableMountRoots },
    });
  await verify();
  const source = await readBootstrapPreparedFile(input.helper, input.writableMountRoots);
  await new Promise<void>((resolve, reject) => {
    const failed = () =>
      reject(new BootstrapRequestConflict("Preclaim executor isolation is unproven"));
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        source.toString("utf8"),
        "preclaim-isolated",
        String(plan.executor.identity.pid),
      ],
      { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" },
    );
    child.once("error", failed);
    child.once("close", (code) => (code === 0 ? resolve() : failed()));
  });
  await verify();
}

async function verifyRetainedPreclaimObservation(
  plan: BootstrapPreclaimRecoveryPlan,
  context: {
    inspector: BootstrapPreclaimRecoveryPlan["setup"];
    writableMountRoots: readonly string[];
  },
): Promise<void> {
  if (!plan.retainedObservation)
    throw new BootstrapRequestConflict("Retained observation is not part of the review");
  const file = BootstrapPreclaimRecoveryPlanSchema.shape.setup;
  const request = z.strictObject({
    id: z.string().uuid(),
    revision: z.string().uuid(),
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  });
  // A historical diagnostic may include explanatory fields. Validate only its
  // identity evidence; never turn a diagnostic's conclusions into authority.
  const schema = z.object({
    version: z.literal(1),
    provenance: z.literal("observed-after-launch"),
    observedAt: z.string().datetime(),
    request,
    setup: file,
    inspector: file,
    ownerLauncher: file,
    executor: AuditedProcessObservationSchema,
    host: BootstrapProcessIdentitySchema,
    coordinator: BootstrapProcessIdentitySchema,
    executionLock: BootstrapPreclaimRecoveryPlanSchema.shape.executionLock,
  });
  const bytes = await readBootstrapPreparedFile(
    plan.retainedObservation,
    context.writableMountRoots,
  );
  const retained = schema.parse(JSON.parse(bytes.toString("utf8")));
  const expectedRequest = {
    id: plan.original.id,
    revision: plan.original.revision,
    planSha256: plan.original.planSha256,
  };
  const expected = {
    version: 1,
    provenance: "observed-after-launch",
    observedAt: retained.observedAt,
    request: expectedRequest,
    setup: plan.setup,
    inspector: context.inspector,
    ownerLauncher: plan.ownerLauncher,
    executor: plan.executor,
    host: plan.hostProcess,
    coordinator: plan.coordinatorProcess,
    executionLock: plan.executionLock,
  };
  if (!isDeepStrictEqual(retained, expected))
    throw new BootstrapRequestConflict("Retained preclaim observation binding changed");
  const setup = z
    .object({
      node: file,
      entrypoint: file,
      renewal: z.object({ hostProcess: BootstrapProcessIdentitySchema, request }),
    })
    .parse(
      JSON.parse(
        (await readBootstrapPreparedFile(plan.setup, context.writableMountRoots)).toString("utf8"),
      ),
    );
  if (
    !isDeepStrictEqual(setup.node, plan.runner.node) ||
    !isDeepStrictEqual(setup.entrypoint, plan.executorEntrypoint) ||
    !isDeepStrictEqual(setup.renewal.hostProcess, plan.hostProcess) ||
    !isDeepStrictEqual(setup.renewal.request, expectedRequest)
  )
    throw new BootstrapRequestConflict("Retained preclaim renewal parent changed");
}

/** Only a separately approved and durably claimed recovery can fence the old
 * request. This is not callable from the old bootstrap approval route. */
export function cancellationFromClaimedRecovery(value: unknown): PreclaimCancellation {
  const request = BootstrapPreclaimRecoveryRequestSchema.parse(value);
  const plan = validatePreclaimRecoveryPlan(request.plan);
  if (
    request.status !== "approved" ||
    request.decisionAt === undefined ||
    request.execution?.stage !== "claimed" ||
    request.planSha256 !== preclaimRecoveryPlanDigest(plan)
  )
    throw new BootstrapRequestConflict("Exact claimed preclaim recovery approval required");
  return validatePreclaimCancellation({
    version: 1,
    recoveryId: request.id,
    recoveryRevision: request.revision,
    recoveryGeneration: request.execution.generation,
    recoveryPlanSha256: request.planSha256,
    original: plan.original,
    canceled: plan.ownerCancellation ?? { ...plan.canceled, decisionAt: request.decisionAt },
    executor: plan.executor,
    ...(plan.ownerCancellation ? { ownerCancellation: plan.ownerCancellation } : {}),
  });
}

export interface PreclaimReviewJournal {
  readReviews(): BootstrapPreclaimRecoveryRequest[];
  replaceReviews(
    expected: BootstrapPreclaimRecoveryRequest[],
    next: BootstrapPreclaimRecoveryRequest[],
  ): void;
}

const RecoveryDecisionIdentity = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Native verification is supplied by the protected Host, never by an RPC.
 * No method here launches an executor or reuses the old bootstrap approval. */
export class PreclaimRecoveryReviews {
  constructor(
    private readonly journal: PreclaimReviewJournal,
    private readonly readBinding: () => BootstrapHostBinding,
    private readonly verify: (plan: BootstrapPreclaimRecoveryPlan) => Promise<void>,
  ) {}

  list(): BootstrapPreclaimRecoveryRequest[] {
    const records = this.journal.readReviews();
    for (const record of records) {
      validatePreclaimRecoveryPlan(record.plan);
      if (record.planSha256 !== preclaimRecoveryPlanDigest(record.plan))
        throw new BootstrapRequestConflict("Preclaim recovery plan digest changed");
    }
    return records;
  }

  private binding(plan: BootstrapPreclaimRecoveryPlan): BootstrapHostBinding {
    const binding = structuredClone(this.readBinding());
    if (
      binding.environment !== "host" ||
      binding.installationId !== plan.original.plan.installationId ||
      binding.service !== plan.original.plan.service
    )
      throw new BootstrapRequestConflict("Preclaim recovery installation changed");
    return binding;
  }

  async prepare(value: unknown): Promise<BootstrapPreclaimRecoveryRequest> {
    const input = BootstrapPreclaimRecoveryPreparationSchema.parse(value);
    const plan = validatePreclaimRecoveryPlan(input.plan);
    const expected = this.list();
    if (
      input.id === plan.original.id ||
      expected.some(
        (record) =>
          record.id === input.id ||
          (record.status !== "canceled" &&
            record.execution?.stage !== "succeeded" &&
            record.execution?.stage !== "aborted_before_effects"),
      )
    )
      throw new BootstrapRequestConflict("Preclaim recovery already open");
    const binding = this.binding(plan);
    await this.verify(plan);
    if (!isDeepStrictEqual(binding, this.binding(plan)))
      throw new BootstrapRequestConflict("Preclaim recovery installation changed");
    const pending: BootstrapPreclaimRecoveryRequest = {
      id: input.id,
      revision: randomUUID(),
      requestedBy: "host-agent",
      reason: input.reason,
      createdAt: new Date().toISOString(),
      plan,
      planSha256: preclaimRecoveryPlanDigest(plan),
      status: "pending",
    };
    this.journal.replaceReviews(expected, [...expected, pending]);
    return structuredClone(pending);
  }

  async decide(
    value: unknown,
    ownerPassword: string,
    reviewAcknowledged: boolean,
  ): Promise<BootstrapPreclaimRecoveryRequest> {
    const input = RecoveryDecisionIdentity.extend({
      decision: z.enum(["approve", "cancel"]),
    }).parse(value);
    if (input.decision === "approve" && reviewAcknowledged !== true)
      throw new BootstrapRequestConflict(
        "Reload to review exact preclaim recovery before approval",
      );
    const expected = this.list();
    const request = expected.find((record) => record.id === input.id);
    if (
      !request ||
      request.revision !== input.revision ||
      request.planSha256 !== input.planSha256 ||
      request.execution ||
      (request.status !== "pending" &&
        !(request.status === "approved" && input.decision === "cancel"))
    )
      throw new BootstrapRequestConflict("Preclaim recovery review changed or dispatch claimed");
    const binding = this.binding(request.plan);
    if (!ownerPassword || !(await compare(ownerPassword, binding.ownerPasswordHash)))
      throw new BootstrapAuthenticationRequired("Installation owner authentication required");
    if (input.decision === "approve") await this.verify(request.plan);
    if (!isDeepStrictEqual(binding, this.binding(request.plan)))
      throw new BootstrapRequestConflict("Preclaim recovery installation changed");
    const next: BootstrapPreclaimRecoveryRequest = {
      ...request,
      revision: randomUUID(),
      status: input.decision === "approve" ? "approved" : "canceled",
      decisionAt: new Date().toISOString(),
    };
    this.journal.replaceReviews(
      expected,
      expected.map((record) => (record.id === next.id ? next : record)),
    );
    return structuredClone(next);
  }

  async claim(value: unknown): Promise<BootstrapPreclaimRecoveryRequest> {
    const input = RecoveryDecisionIdentity.parse(value);
    const expected = this.list();
    const request = expected.find((record) => record.id === input.id);
    if (
      !request ||
      request.revision !== input.revision ||
      request.planSha256 !== input.planSha256 ||
      request.status !== "approved" ||
      request.execution
    )
      throw new BootstrapRequestConflict("Exact undispatched preclaim recovery approval required");
    const binding = this.binding(request.plan);
    await this.verify(request.plan);
    if (!isDeepStrictEqual(binding, this.binding(request.plan)))
      throw new BootstrapRequestConflict("Preclaim recovery installation changed");
    const claimed: BootstrapPreclaimRecoveryRequest = {
      ...request,
      revision: randomUUID(),
      execution: {
        generation: randomUUID(),
        stage: "claimed",
        updatedAt: new Date().toISOString(),
      },
    };
    // Check the complete cancellation before claiming any authority for it.
    cancellationFromClaimedRecovery(claimed);
    this.journal.replaceReviews(
      expected,
      expected.map((record) => (record.id === claimed.id ? claimed : record)),
    );
    return structuredClone(claimed);
  }

  advance(
    expectedRequest: BootstrapPreclaimRecoveryRequest,
    stage: PreclaimRecoveryStage,
  ): BootstrapPreclaimRecoveryRequest {
    const expected = this.list();
    const current = expected.find((record) => record.id === expectedRequest.id);
    if (
      !current ||
      !isDeepStrictEqual(current, expectedRequest) ||
      current.status !== "approved" ||
      !current.execution
    )
      throw new BootstrapRequestConflict("Preclaim recovery execution ownership changed");
    const transitions: Record<PreclaimRecoveryStage, readonly PreclaimRecoveryStage[]> = {
      claimed: ["cancellation_fenced", "recovery_required"],
      cancellation_fenced: ["effect_pending", "verifying", "recovery_required"],
      effect_pending: ["verifying", "recovery_required"],
      verifying: ["succeeded", "recovery_required"],
      succeeded: [],
      recovery_required: ["verifying"],
      // Only the atomic journal proof can establish this terminal result.
      aborted_before_effects: [],
    };
    if (!transitions[current.execution.stage].includes(stage))
      throw new BootstrapRequestConflict("Invalid preclaim recovery transition");
    const next: BootstrapPreclaimRecoveryRequest = {
      ...current,
      revision: randomUUID(),
      execution: { ...current.execution, stage, updatedAt: new Date().toISOString() },
    };
    this.journal.replaceReviews(
      expected,
      expected.map((record) => (record.id === next.id ? next : record)),
    );
    return structuredClone(next);
  }
}

type PreclaimRecoveryStage = NonNullable<BootstrapPreclaimRecoveryRequest["execution"]>["stage"];

export interface PreclaimExecutionJournal {
  abortBeforeEffects(
    expected: BootstrapPreclaimRecoveryRequest,
  ): BootstrapPreclaimRecoveryRequest | null;
  fence(value: unknown): PreclaimRecoveryRecord;
  assertFenced(cancellation: PreclaimCancellation): void;
  inspect(id: string): PreclaimRecoveryRecord | null;
  reserveEffect(input: {
    cancellation: PreclaimCancellation;
    effect: "terminate" | "kill";
    at: string;
  }): void;
}

/** Recheck the exact durable revision at the native dispatch boundary. A reserved
 * intent is permission for one attempt, never evidence that an effect completed. */
export function verifyPreclaimEffectRequest(input: {
  request: BootstrapPreclaimRecoveryRequest;
  reviews: readonly BootstrapPreclaimRecoveryRequest[];
  retained: PreclaimRecoveryRecord | null;
  effect: "terminate" | "kill";
}): void {
  const request = BootstrapPreclaimRecoveryRequestSchema.parse(input.request);
  validatePreclaimRecoveryPlan(request.plan);
  const current = input.reviews.filter((record) => record.id === request.id);
  if (
    current.length !== 1 ||
    !isDeepStrictEqual(current[0], request) ||
    request.status !== "approved" ||
    request.execution?.stage !== "effect_pending" ||
    request.planSha256 !== preclaimRecoveryPlanDigest(request.plan)
  )
    throw new BootstrapRequestConflict("Exact recovery effect revision required");
  const retained = input.retained;
  if (!retained?.fenced)
    throw new BootstrapRequestConflict("Recovery effect requires durable cancellation");
  const cancellation = cancellationFromClaimedRecovery({
    ...request,
    revision: retained.cancellation.recoveryRevision,
    execution: { ...request.execution, stage: "claimed" },
  });
  if (!isDeepStrictEqual(retained.cancellation, cancellation))
    throw new BootstrapRequestConflict("Recovery effect cancellation binding changed");
  const intentMatches =
    input.effect === "terminate"
      ? retained.terminateIntentAt !== null && retained.killIntentAt === null
      : request.plan.signalPolicy.escalation === "SIGKILL" &&
        retained.terminateIntentAt !== null &&
        retained.killIntentAt !== null;
  if (!intentMatches)
    throw new BootstrapRequestConflict("Recovery effect is not reserved by the reviewed policy");
}

/** Called only by the managed runner while it owns recovery exclusion. Paths
 * and helpers come from selected Host setup, never the recovery RPC payload. */
export async function dispatchPreclaimNativeEffect(input: {
  request: BootstrapPreclaimRecoveryRequest;
  effect: "terminate" | "kill";
  journal: PreclaimReviewJournal & PreclaimExecutionJournal;
  recoveryDescriptor: number;
  helper: BootstrapPreclaimRecoveryPlan["ownerLauncher"];
  inspector: BootstrapPreclaimRecoveryPlan["setup"];
  reader: NativeBootstrapServiceReader;
  launcherFile: string;
  configurationFile: string;
  writableMountRoots: readonly string[];
}): Promise<void> {
  if (
    process.platform !== "darwin" ||
    !Number.isSafeInteger(input.recoveryDescriptor) ||
    input.recoveryDescriptor < 3
  )
    throw new BootstrapRequestConflict("Native recovery exclusion required");
  const request = BootstrapPreclaimRecoveryRequestSchema.parse(input.request);
  const verifyDecision = () => {
    const retained = input.journal.inspect(request.id);
    verifyPreclaimEffectRequest({
      request,
      reviews: input.journal.readReviews(),
      retained,
      effect: input.effect,
    });
    if (!retained) throw new BootstrapRequestConflict("Recovery cancellation is unavailable");
    input.journal.assertFenced(retained.cancellation);
  };
  verifyDecision();
  const { plan } = request;
  await verifyBootstrapReleaseArtifacts(plan.runner, input.writableMountRoots);
  for (const file of [plan.setup, plan.executorEntrypoint, plan.ownerLauncher, input.inspector])
    await readBootstrapPreparedFile(file, input.writableMountRoots);
  const helper = await readBootstrapPreparedFile(input.helper, input.writableMountRoots);
  await verifyPreclaimLiveProcesses({
    plan,
    reader: input.reader,
    retainedContext: { inspector: input.inspector, writableMountRoots: input.writableMountRoots },
  });
  await verifyPreclaimSelectedService({ ...input, plan });
  verifyDecision();
  await new Promise<void>((resolve, reject) => {
    let diagnostic = "";
    const failed = () => {
      const known =
        /^preclaim:(review_changed|cancellation_unproven|execution_lock_changed|process_changed|children_unproven|effect_unreserved|effect_outcome_uncertain|verification_failed)\n$/.exec(
          diagnostic,
        );
      reject(
        new BootstrapRequestConflict(
          `Preclaim native effect refused: ${known?.[1] ?? "verification_failed"}`,
        ),
      );
    };
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        helper.toString("utf8"),
        "preclaim-effect",
        plan.original.plan.state.directory,
        request.id,
        request.revision,
        request.execution!.generation,
        request.planSha256,
        input.effect,
        input.inspector.path,
        input.inspector.sha256,
      ],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "ignore", "pipe", input.recoveryDescriptor],
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    child.stderr!.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString("utf8")).slice(0, 256);
    });
    child.once("error", failed);
    child.once("close", (code) => (code === 0 ? resolve() : failed()));
  });
}

/** A failed live inspection is never exit evidence. Only the native reader's
 * independent ESRCH proof can convert it to an exited observation. */
export async function observePreclaimExecutor(
  input: Parameters<typeof verifyPreclaimLiveProcesses>[0],
): Promise<"alive" | "exited"> {
  validatePreclaimRecoveryPlan(input.plan);
  try {
    await verifyPreclaimLiveProcesses(input);
    return "alive";
  } catch (inspectionError) {
    try {
      await input.reader.verifyProcessExited(input.plan.executor.identity.pid);
    } catch {
      throw inspectionError;
    }
    return "exited";
  }
}

interface PreclaimExitWaitPorts {
  observe(): Promise<"alive" | "exited">;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

/** The managed runner owns the wait. Expiration returns alive, not success and
 * not permission for an unreviewed escalation. Every observation checks birth. */
export async function waitForPreclaimExecutorExit(input: {
  plan: BootstrapPreclaimRecoveryPlan;
  ports: PreclaimExitWaitPorts;
}): Promise<"alive" | "exited"> {
  const plan = validatePreclaimRecoveryPlan(input.plan);
  const started = input.ports.now();
  const deadline = started + plan.signalPolicy.graceSeconds * 1000;
  if (!Number.isFinite(started) || !Number.isFinite(deadline))
    throw new BootstrapRequestConflict("Recovery wait clock is unavailable");
  let previous = started;
  for (;;) {
    if ((await input.ports.observe()) === "exited") return "exited";
    const now = input.ports.now();
    if (!Number.isFinite(now) || now < previous)
      throw new BootstrapRequestConflict("Recovery wait clock changed");
    previous = now;
    if (now >= deadline) return "alive";
    await input.ports.sleep(Math.min(100, deadline - now));
  }
}

export interface PreclaimNativeOperations {
  /** Excludes other recovery executors, without stealing the target's execution lock. */
  withRecoveryOwnership<T>(operation: () => Promise<T>): Promise<T>;
  verifyBeforeCancellation(request: BootstrapPreclaimRecoveryRequest): Promise<void>;
  /** Alive means the exact audited birth, argv and protected bindings still match.
   * Exited requires native absence, not a timeout or a different process at the PID. */
  inspectExecutor(request: BootstrapPreclaimRecoveryRequest): Promise<"alive" | "exited">;
  verifyBeforeEffect(request: BootstrapPreclaimRecoveryRequest): Promise<void>;
  terminateExact(request: BootstrapPreclaimRecoveryRequest): Promise<void>;
  waitAfterTermination(request: BootstrapPreclaimRecoveryRequest): Promise<"alive" | "exited">;
  killExact(request: BootstrapPreclaimRecoveryRequest): Promise<void>;
  waitAfterKill(request: BootstrapPreclaimRecoveryRequest): Promise<void>;
  /** Invoke only after independent exit, ownership of the original lock inode,
   * and unchanged coordinator/launcher/configuration proofs. Hold exclusion
   * through the durable terminal write; lock ownership alone is not exit proof. */
  withVerifiedExitAndSelection<T>(
    request: BootstrapPreclaimRecoveryRequest,
    operation: () => T,
  ): Promise<T>;
}

/** The fixed runner inherits this descriptor from its protected launcher.
 * A number or a lock pathname alone is not evidence of kernel ownership. */
export async function verifyPreclaimRecoveryOwnership(input: {
  stateDirectory: string;
  recoveryDescriptor: number;
  helper: BootstrapPreclaimRecoveryPlan["ownerLauncher"];
  writableMountRoots: readonly string[];
}): Promise<void> {
  if (
    process.platform !== "darwin" ||
    !Number.isSafeInteger(input.recoveryDescriptor) ||
    input.recoveryDescriptor < 3
  )
    throw new BootstrapRequestConflict("Native recovery exclusion required");
  await assertBootstrapPathsProtected([input.stateDirectory], input.writableMountRoots);
  const source = await readBootstrapPreparedFile(input.helper, input.writableMountRoots);
  await new Promise<void>((resolve, reject) => {
    const failed = () =>
      reject(new BootstrapRequestConflict("Preclaim recovery ownership unproven"));
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-B", "-c", source.toString("utf8"), "preclaim-owned", input.stateDirectory],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "ignore", "ignore", input.recoveryDescriptor],
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    child.once("error", failed);
    child.once("close", (code) => (code === 0 ? resolve() : failed()));
  });
}

/** Compose native proofs and effects without exposing a PID signal operation.
 * The managed runner supplies every path and its supported-runner verifier.
 * This adapter does not acquire a lock, launch a runner, or advertise readiness. */
export function createPreclaimNativeOperations(input: {
  stateDirectory: string;
  recoveryDescriptor: number;
  helper: BootstrapPreclaimRecoveryPlan["ownerLauncher"];
  inspector: BootstrapPreclaimRecoveryPlan["setup"];
  reader: NativeBootstrapServiceReader;
  launcherFile: string;
  configurationFile: string;
  writableMountRoots: readonly string[];
  journal: PreclaimReviewJournal & PreclaimExecutionJournal;
  verifySupportedPlan(plan: BootstrapPreclaimRecoveryPlan): Promise<void>;
}): PreclaimNativeOperations {
  // Snapshot configuration supplied by the selected Host. Preserve the native
  // reader and journal methods, which are not serializable configuration.
  const context = {
    ...input,
    helper: { ...input.helper },
    inspector: { ...input.inspector },
    writableMountRoots: [...input.writableMountRoots],
  };
  let active = false;
  const owned = () => verifyPreclaimRecoveryOwnership(context);
  const check = async (request: BootstrapPreclaimRecoveryRequest) => {
    if (!active || request.plan.original.plan.state.directory !== context.stateDirectory)
      throw new BootstrapRequestConflict("Recovery operation is outside its owned state");
    await owned();
    await context.verifySupportedPlan(validatePreclaimRecoveryPlan(request.plan));
  };
  const observe = (request: BootstrapPreclaimRecoveryRequest) =>
    observePreclaimExecutor({
      plan: request.plan,
      reader: context.reader,
      retainedContext: {
        inspector: context.inspector,
        writableMountRoots: context.writableMountRoots,
      },
    });
  const verify = async (request: BootstrapPreclaimRecoveryRequest) => {
    await check(request);
    await verifyPreclaimSelectedService({ ...context, plan: request.plan });
    await observe(request);
  };
  const wait = async (request: BootstrapPreclaimRecoveryRequest) => {
    await check(request);
    return waitForPreclaimExecutorExit({
      plan: request.plan,
      ports: {
        observe: () => observe(request),
        now: () => performance.now(),
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      },
    });
  };
  const sendEffect = async (
    request: BootstrapPreclaimRecoveryRequest,
    effect: "terminate" | "kill",
  ) => {
    await check(request);
    await dispatchPreclaimNativeEffect({ ...context, request, effect });
  };
  return {
    withRecoveryOwnership: async (operation) => {
      if (active) throw new BootstrapRequestConflict("Recovery executor is already active");
      // Set synchronously so two callers cannot both pass an asynchronous proof.
      active = true;
      try {
        await owned();
        return await operation();
      } finally {
        active = false;
      }
    },
    verifyBeforeCancellation: verify,
    verifyBeforeEffect: verify,
    inspectExecutor: async (request) => {
      await check(request);
      return observe(request);
    },
    terminateExact: (request) => sendEffect(request, "terminate"),
    killExact: (request) => sendEffect(request, "kill"),
    waitAfterTermination: wait,
    waitAfterKill: async (request) => {
      if ((await wait(request)) !== "exited")
        throw new BootstrapRequestConflict("Reviewed escalation did not establish executor exit");
    },
    withVerifiedExitAndSelection: async (request, operation) => {
      await check(request);
      return withPreclaimTerminalSelection({
        ...context,
        request,
        operation: async () => {
          await owned();
          return operation();
        },
      });
    },
  };
}

interface PreclaimExecutionInput {
  reviews: PreclaimRecoveryReviews;
  identity: { id: string; revision: string; planSha256: string };
  journal: PreclaimExecutionJournal;
  native: PreclaimNativeOperations;
}

/** Runs a fresh approval once. An uncertain outcome consumes reserved effects;
 * observation recovery cannot use this entrypoint to replay them. */
export async function executePreclaimRecovery(
  input: PreclaimExecutionInput,
): Promise<BootstrapPreclaimRecoveryRequest> {
  return input.native.withRecoveryOwnership(async () => {
    let request = await input.reviews.claim(input.identity);
    const cancellation = cancellationFromClaimedRecovery(request);
    const advance = (stage: PreclaimRecoveryStage) => {
      request = input.reviews.advance(request, stage);
      return request;
    };
    try {
      await input.native.verifyBeforeCancellation(request);
      input.journal.fence(cancellation);
      advance("cancellation_fenced");
      if ((await input.native.inspectExecutor(request)) === "alive") {
        await input.native.verifyBeforeEffect(request);
        input.journal.reserveEffect({
          cancellation,
          effect: "terminate",
          at: new Date().toISOString(),
        });
        advance("effect_pending");
        verifyPreclaimEffectRequest({
          request,
          reviews: input.reviews.list(),
          retained: input.journal.inspect(request.id),
          effect: "terminate",
        });
        input.journal.assertFenced(cancellation);
        await input.native.terminateExact(request);
        if ((await input.native.waitAfterTermination(request)) === "alive") {
          if (request.plan.signalPolicy.escalation !== "SIGKILL")
            throw new BootstrapRequestConflict(
              "Reviewed termination did not establish executor exit",
            );
          await input.native.verifyBeforeEffect(request);
          input.journal.reserveEffect({
            cancellation,
            effect: "kill",
            at: new Date().toISOString(),
          });
          verifyPreclaimEffectRequest({
            request,
            reviews: input.reviews.list(),
            retained: input.journal.inspect(request.id),
            effect: "kill",
          });
          input.journal.assertFenced(cancellation);
          await input.native.killExact(request);
          await input.native.waitAfterKill(request);
        }
      }
      advance("verifying");
      return await input.native.withVerifiedExitAndSelection(request, () => {
        input.journal.assertFenced(cancellation);
        return advance("succeeded");
      });
    } catch {
      const aborted = input.journal.abortBeforeEffects(request);
      if (aborted) return aborted;
      return advance("recovery_required");
    }
  });
}

/** Only observe a retained generation. No signal method is available here. */
export async function reconcilePreclaimRecovery(
  input: Omit<PreclaimExecutionInput, "native"> & {
    native: Pick<
      PreclaimNativeOperations,
      "withRecoveryOwnership" | "withVerifiedExitAndSelection"
    >;
  },
): Promise<BootstrapPreclaimRecoveryRequest> {
  return input.native.withRecoveryOwnership(async () => {
    const identity = RecoveryDecisionIdentity.parse(input.identity);
    let request = input.reviews.list().find((record) => record.id === identity.id);
    const retained = input.journal.inspect(identity.id);
    if (
      !request ||
      request.revision !== identity.revision ||
      request.planSha256 !== identity.planSha256 ||
      request.status !== "approved" ||
      !request.execution
    )
      throw new BootstrapRequestConflict("Exact retained preclaim recovery generation required");
    if (request.execution.stage === "aborted_before_effects") return request;
    if (retained === null) {
      const aborted = input.journal.abortBeforeEffects(request);
      if (aborted) return aborted;
    }
    if (
      !retained?.fenced ||
      retained.cancellation.recoveryGeneration !== request.execution.generation ||
      retained.cancellation.recoveryPlanSha256 !== request.planSha256
    )
      throw new BootstrapRequestConflict("Exact retained preclaim recovery generation required");
    const expected = cancellationFromClaimedRecovery({
      ...request,
      revision: retained.cancellation.recoveryRevision,
      execution: { ...request.execution, stage: "claimed" },
    });
    if (!isDeepStrictEqual(retained.cancellation, expected))
      throw new BootstrapRequestConflict("Retained preclaim recovery cancellation changed");
    if (request.execution.stage === "succeeded") return request;
    if (request.execution.stage === "claimed")
      request = input.reviews.advance(request, "cancellation_fenced");
    if (request.execution?.stage !== "verifying")
      request = input.reviews.advance(request, "verifying");
    const verifying = request;
    try {
      return await input.native.withVerifiedExitAndSelection(verifying, () => {
        input.journal.assertFenced(expected);
        return input.reviews.advance(verifying, "succeeded");
      });
    } catch {
      return input.reviews.advance(verifying, "recovery_required");
    }
  });
}
