import { readBoundedMaintenanceInspection } from "./coordinator-bootstrap-maintenance-service-native.js";
import { verifyUnclaimedMaintenanceExecutor } from "./coordinator-bootstrap-maintenance-runner-contract.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceRecoveryLinkSchema,
} from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  inspectRetainedMaintenanceServiceEffect,
  inspectRetainedUnclaimedMaintenanceService,
} from "./coordinator-bootstrap-maintenance-service-binding.js";
import { MaintenanceRecoveryPlanSchema } from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import {
  inspectRetainedMaintenanceRecoveryEffect,
  inspectRetainedUnclaimedMaintenanceRecovery,
} from "./coordinator-bootstrap-maintenance-recovery-binding.js";
import { verifyRetainedProcessExited } from "./coordinator-bootstrap-service.js";

/** Evidence prerequisite only, never permission to dispatch or replay. The
 * caller must recheck this retained snapshot inside the new claim transaction. */
export async function verifyMaintenanceRecoveryPredecessor(input: {
  retained: unknown;
  plan: unknown;
  account: { uid: number; home: string };
  recoveryOf: unknown;
  reader: Parameters<typeof verifyRetainedProcessExited>[0];
  currentBoot?: RecoveryBootWitness;
}) {
  const context = inspectMaintenanceRecoveryPredecessor(input);
  const contract = context.intent
    ? undefined
    : await readBoundedMaintenanceInspection(
        (signal) =>
          verifyUnclaimedMaintenanceExecutor({
            ...input,
            job: context.job,
            stateDirectory: ("identity" in context ? context.identity : context.plan.identity)
              .stateDirectory,
            signal,
          }),
        { timeoutMs: 10_000, detail: "Unclaimed predecessor contract inspection timed out" },
      );
  const assertExit = context.intent
    ? await verifyRecoveryExecutorExit({
        reader: input.reader,
        expected: context.intent.executor,
        installationId: context.job.proposal.installationId,
        currentBoot: input.currentBoot,
      })
    : () => contract!.assertCurrent();
  return { ...context, assertExit };
}

/** Structural history verification is also needed by observation-only startup.
 * It must not be mistaken for live executor exit or dispatch authorization. */
export function inspectMaintenanceRecoveryPredecessor(input: {
  retained: unknown;
  plan: unknown;
  account: { uid: number; home: string };
  recoveryOf: unknown;
}) {
  const jobState = MaintenanceServiceJobSchema.parse(input.retained);
  const recovery = MaintenanceRecoveryPlanSchema.safeParse(input.plan).success;
  const inspectConsumed = recovery
    ? inspectRetainedMaintenanceRecoveryEffect
    : inspectRetainedMaintenanceServiceEffect;
  const inspectUnclaimed = recovery
    ? inspectRetainedUnclaimedMaintenanceRecovery
    : inspectRetainedUnclaimedMaintenanceService;
  const context = jobState.effectIntent ? inspectConsumed(input) : inspectUnclaimed(input);
  const link = MaintenanceServiceRecoveryLinkSchema.parse(input.recoveryOf);
  const { job, reservation, intent } = context;
  const observation = job.observation;
  if (
    job.status === "succeeded" ||
    !observation ||
    observation.ready ||
    link.requestId !== job.id ||
    link.generation !== reservation.generation ||
    link.planSha256 !== context.planSha256 ||
    link.observationSha256 !== observation.evidenceSha256 ||
    observation.requestId !== job.id ||
    observation.requestRevision !== reservation.requestRevision ||
    observation.generation !== reservation.generation ||
    observation.planSha256 !== context.planSha256 ||
    observation.identitySha256 !== context.identitySha256 ||
    Date.parse(observation.observedAt) <
      Date.parse(intent ? intent.consumedAt : reservation.reservedAt)
  ) {
    throw new BootstrapRequestConflict(
      "Recovery predecessor differs from retained failed observation",
    );
  }
  const record = requireRecoveryRecord(context, observation);
  return { ...context, observation, record };
}

function requireRecoveryRecord(
  context: Pick<
    ReturnType<typeof inspectRetainedMaintenanceServiceEffect>,
    "job" | "reservation" | "planSha256" | "identitySha256"
  >,
  observation: NonNullable<
    ReturnType<typeof inspectRetainedMaintenanceServiceEffect>["job"]["observation"]
  >,
) {
  const { job, reservation } = context;
  const matches = job.evidence.filter((item) => item.sha256 === observation.evidenceSha256);
  const record = matches[0]?.record;
  if (
    matches.length !== 1 ||
    !record ||
    createHash("sha256").update(JSON.stringify(record)).digest("hex") !==
      observation.evidenceSha256 ||
    record.requestId !== job.id ||
    record.requestRevision !== reservation.requestRevision ||
    record.planSha256 !== context.planSha256 ||
    record.identitySha256 !== context.identitySha256 ||
    record.observedAt !== observation.observedAt ||
    record.sourceCommit !== observation.sourceCommit ||
    record.artifactSha256 !== observation.artifactSha256
  ) {
    throw new BootstrapRequestConflict("Recovery predecessor lacks exact retained native evidence");
  }
  return record;
}

/** Supplied only by trusted native inspection, never parsed from a proposal.
 * The assertion must recheck the exact observed live process synchronously. */
export interface RecoveryBootWitness {
  target: "maintenance-controller" | "recovery-launcher";
  installationId: string;
  process: ReturnType<typeof BootstrapProcessIdentitySchema.parse>;
  assertCurrent(): void;
}

/** A process cannot survive its boot. A fresh, independently verified process
 * on another boot proves this without interpreting a reused PID as the old one.
 * Same-boot recovery retains the ordinary native exit requirement. */
export async function verifyRecoveryExecutorExit(input: {
  reader: Parameters<typeof verifyRetainedProcessExited>[0];
  expected: ReturnType<typeof BootstrapProcessIdentitySchema.parse>;
  installationId: string;
  currentBoot?: RecoveryBootWitness;
}): Promise<() => void> {
  const expected = BootstrapProcessIdentitySchema.parse(input.expected);
  const witness = input.currentBoot;
  if (!witness) {
    await verifyRetainedProcessExited(input.reader, expected);
    return () => undefined;
  }
  const current = BootstrapProcessIdentitySchema.parse(witness.process);
  const assertCurrent = () => {
    if (
      witness.installationId !== input.installationId ||
      current.uid !== expected.uid ||
      !isDeepStrictEqual(current, witness.process) ||
      witness.assertCurrent() !== undefined
    )
      throw new BootstrapRequestConflict("Recovery current boot custody is unproven");
  };
  assertCurrent();
  if (current.bootId === expected.bootId) await verifyRetainedProcessExited(input.reader, expected);
  assertCurrent();
  return assertCurrent;
}
