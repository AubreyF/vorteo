import { createHash } from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { retainMaintenancePublishedFile } from "../coordinator-bootstrap-maintenance-file-selection.js";
import {
  withHostContinuationAdmission,
  type FileEnrollmentJournal,
  type HostContinuationConsumption,
  type EnrollmentWriteFiles,
} from "./authorization.js";
import { writeInitialHostArtifact } from "./host-supervisor-migration.js";
import { retainBinding } from "./host-supervisor-continuation.js";

const operationSchema = z.enum(["interruption", "retirement", "bootstrap"]);
type Operation = z.infer<typeof operationSchema>;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Captured protected dispatch evidence, not delivery or reusable authority. */
export const HostContinuationCommandQueueAttemptSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("host-continuation-command-queue-attempt"),
  command: operationSchema,
  role: z.enum(["restoration", "candidate"]),
  stepId: z.uuid(),
  generation: z.uuid(),
  reservationSha256: digestSchema,
  intentSha256: digestSchema,
  claimSha256: digestSchema,
  executor: BootstrapProcessIdentitySchema,
  scope: z.strictObject({
    identitySha256: digestSchema,
    artifactSha256: digestSchema,
    preconditionSha256: digestSchema,
  }),
  fenceSha256: digestSchema,
  commandSha256: digestSchema,
  channelSha256: digestSchema,
});

/** Produced by the independently verified native command owner, never parsed
 * from an HTTP request. The assertion must bind the actual retained channel,
 * fixed command and original native executor, including boot and birth. This
 * helper supplies no such producer and no default command implementation. */
export interface HostContinuationCommandOwner {
  operation: Operation;
  executor: z.infer<typeof BootstrapProcessIdentitySchema>;
  /** Actual immutable data used by the native owner's fixed enqueue operation. */
  command: object;
  /** Actual live handle retained by that owner, not a serialized capability. */
  channel: object;
  /** Independently measured native identity of that same live channel. */
  channelIdentity: object;
  scope: {
    identitySha256: string;
    artifactSha256: string;
    preconditionSha256: string;
  };
  fence: { file: string; bytes: Uint8Array };
  assertCurrent(): void;
  /** Synchronous one-use queue call only. Completion is observed separately. */
  enqueue(): void;
}

function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(`Host command attempt: ${message}`);
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function synchronous(callback: () => void) {
  const result: unknown = callback();
  requireProof(result === undefined, "custody and enqueue must complete synchronously");
}

/** Preserve the publisher's canonical field order for read-only collectors.
 * This data-only builder establishes no custody, admission or native facts. */
export function hostContinuationCommandQueueAttemptRecord(input: {
  consumption: HostContinuationConsumption;
  operation: Operation;
  executor: HostContinuationCommandOwner["executor"];
  scope: HostContinuationCommandOwner["scope"];
  fenceBytes: Uint8Array;
  command: object;
  channelIdentity: object;
}) {
  return {
    version: 1 as const,
    operation: "host-continuation-command-queue-attempt" as const,
    command: input.operation,
    role: input.consumption.role,
    stepId: input.consumption.stepId,
    generation: input.consumption.generation,
    reservationSha256: input.consumption.reservationSha256,
    intentSha256: input.consumption.intentSha256,
    claimSha256: input.consumption.claimSha256,
    executor: input.executor,
    scope: input.scope,
    fenceSha256: createHash("sha256").update(input.fenceBytes).digest("hex"),
    commandSha256: digest(input.command),
    channelSha256: digest(input.channelIdentity),
  };
}

/** One addressed attempt for one already-consumed child operation. The native
 * owner calls this at its actual queue boundary. Two locked transactions keep
 * the durable attempt before queueing; every reconstruction meets O_EXCL.
 *
 * A return proves only that the synchronous enqueue call returned. Throws,
 * partial writes, lost replies and later fsync failure never permit replay.
 * No native wait or completion occurs while lifecycle admission is held. */
export function attemptHostContinuationCommand(
  journal: FileEnrollmentJournal,
  consumption: HostContinuationConsumption,
  owner: HostContinuationCommandOwner,
  files?: Pick<EnrollmentWriteFiles, "open" | "write" | "sync" | "close">,
): void {
  const retained = retainBinding(consumption);
  const operation = operationSchema.parse(owner.operation);
  const role = z.enum(["restoration", "candidate"]).parse(consumption.role);
  const writes = files && { ...files };
  requireProof(
    role === "candidate" || operation === "bootstrap",
    "operation is not permitted for the consumed role",
  );
  const executor = BootstrapProcessIdentitySchema.parse(owner.executor);
  requireProof(
    isDeepStrictEqual(executor, consumption.executor) &&
      executor.pid === process.pid &&
      executor.parentPid === process.ppid &&
      executor.uid === process.getuid?.() &&
      executor.executable === realpathSync(process.execPath),
    "only the original consumed native executor may attempt a command",
  );
  const native = retainBinding({
    executor: owner.executor,
    command: owner.command,
    channelIdentity: owner.channelIdentity,
    scope: owner.scope,
    fence: owner.fence,
  });
  const command = owner.command,
    channel = owner.channel,
    channelIdentity = owner.channelIdentity,
    scope = owner.scope,
    fence = owner.fence,
    nativeExecutor = owner.executor,
    assertNative = owner.assertCurrent,
    enqueue = owner.enqueue;
  requireProof(
    command !== null &&
      channel !== null &&
      typeof channel === "object" &&
      typeof assertNative === "function" &&
      typeof enqueue === "function",
    "retained native command and channel are required",
  );
  // Reject callbacks, accessors and non-JSON command/identity payloads. Live
  // channel objects are deliberately retained by reference instead of cloned.
  z.json().parse(native.snapshot.command);
  z.json().parse(native.snapshot.channelIdentity);
  const prefix = path.join(
    journal.stateDirectory,
    `host-continuation-${z.uuid().parse(consumption.stepId)}-${role}-${z.uuid().parse(consumption.generation)}`,
  );
  requireProof(
    fence.file === `${prefix}-${operation}-attempt.json`,
    "command fence is misaddressed",
  );
  const fenceBytes = Buffer.from(native.snapshot.fence.bytes);
  const fenceRecord = z
    .object({
      version: z.literal(1),
      role: z.literal(role),
      stepId: z.literal(consumption.stepId),
      generation: z.literal(consumption.generation),
      reservationSha256: z.literal(consumption.reservationSha256),
      intentSha256: z.literal(consumption.intentSha256),
      claimSha256: z.literal(consumption.claimSha256),
      planSha256: z.string().regex(/^[a-f0-9]{64}$/),
      operation: z.literal(operation),
    })
    .parse(JSON.parse(fenceBytes.toString("utf8")));
  const retainFenceParents = retainServiceFiles([journal.stateDirectory, fence.file]);
  const retainFence = retainMaintenancePublishedFile(fence.file, fenceBytes);
  const assertReferences = () => {
    retained.check();
    native.check();
    requireProof(
      executor.pid === process.pid &&
        executor.parentPid === process.ppid &&
        executor.uid === process.getuid?.() &&
        executor.executable === realpathSync(process.execPath) &&
        owner.operation === operation &&
        owner.executor === nativeExecutor &&
        owner.command === command &&
        owner.channel === channel &&
        owner.channelIdentity === channelIdentity &&
        owner.scope === scope &&
        owner.fence === fence &&
        owner.assertCurrent === assertNative &&
        owner.enqueue === enqueue,
      "native command owner binding changed",
    );
  };
  const check = () => {
    assertReferences();
    retainFenceParents();
    retainFence();
    assertAttempt?.();
    synchronous(() => assertNative.call(owner));
    assertReferences();
    retainFenceParents();
    retainFence();
    assertAttempt?.();
  };
  const input = retained.snapshot;
  const originalCurrent = input.assertCurrent,
    originalExclusive = input.assertExclusive;
  const admission: HostContinuationConsumption = {
    ...input,
    assertCurrent(context) {
      check();
      synchronous(() => originalCurrent.call(consumption, context));
      check();
    },
    assertExclusive(context) {
      check();
      synchronous(() => originalExclusive.call(consumption, context));
      check();
    },
  };
  const attemptFile = `${prefix}-${operation}-queue-attempt.json`;
  let assertAttempt: (() => void) | undefined;
  withHostContinuationAdmission(journal, admission, (context, reassert) => {
    requireProof(
      fenceRecord.planSha256 === context.lineage.binding.planSha256,
      "fence plan differs",
    );
    const target =
      role === "candidate" && operation === "bootstrap"
        ? context.plan.candidate
        : context.plan.fallback;
    requireProof(
      isDeepStrictEqual(native.snapshot.scope, {
        identitySha256: context.lineage.binding.identitySha256,
        artifactSha256: target.artifactSha256,
        preconditionSha256:
          role === "candidate"
            ? context.lineage.candidate!.evidence.preconditionSha256
            : context.plan.preconditionSha256,
      }),
      "native command target differs from consumed operation",
    );
    reassert();
    const record = hostContinuationCommandQueueAttemptRecord({
      consumption,
      operation,
      executor,
      scope: native.snapshot.scope,
      fenceBytes,
      command: native.snapshot.command,
      channelIdentity: native.snapshot.channelIdentity,
    });
    writeInitialHostArtifact(journal.stateDirectory, attemptFile, record, writes);
    assertAttempt = retainMaintenancePublishedFile(
      attemptFile,
      Buffer.from(JSON.stringify(record)),
    );
    reassert();
    assertAttempt();
  });
  requireProof(assertAttempt, "durable command attempt is unavailable");
  const retainedAttempt = assertAttempt;
  // Once the attempt exists, ANY failed admission leaves it consumed. No
  // exception path removes it or rebuilds a callable capability from its bytes.
  withHostContinuationAdmission(journal, admission, (_context, reassert) => {
    // This is the LAST callback-bearing check. It performs native/file custody
    // and then rereads current policy under the lifecycle lock.
    reassert();
    // No supplied callback may run between that policy read and enqueue.
    retainFenceParents();
    retainFence();
    retainedAttempt();
    synchronous(() => Reflect.apply(enqueue, owner, []));
    assertReferences();
    retainedAttempt();
  });
}
