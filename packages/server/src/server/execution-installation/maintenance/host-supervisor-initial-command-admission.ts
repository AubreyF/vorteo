import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  BootstrapAuditedProcessSchema,
  BootstrapProcessIdentitySchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { DaemonMaintenanceProcessSchema } from "@getpaseo/protocol/maintenance-interruption";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import { retainCustodyBinding } from "../retained-custody-binding.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { retainMaintenancePublishedFile } from "../coordinator-bootstrap-maintenance-file-selection.js";
import type { EnrollmentWriteFiles } from "./authorization.js";
import {
  withInitialHostCommandAdmission,
  writeInitialHostArtifact,
  type InitialHostCommandActor,
  type InitialHostCommandContext,
} from "./host-supervisor-migration.js";
import {
  InitialHostMigrationIntentSchema,
  InitialHostMigrationClaimSchema,
  inspectInitialHostSupervisorMigrationPlan,
  inspectInitialHostNativeLaunchBinding,
} from "./host-supervisor-contract.js";

export const InitialHostCommandOperationSchema = z.enum([
  "release",
  "interruption",
  "retirement",
  "bootstrap",
]);
export type InitialHostCommandOperation = z.infer<typeof InitialHostCommandOperationSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && value !== "/" && path.normalize(value) === value);
const scopeBinding = {
  identitySha256: digest,
  preconditionSha256: digest,
  service: z.string().min(1).max(4096),
};
/** Selectors only. In particular, initial incumbent scope claims no imported
 * runtime artifact provenance for the original service-custody observation. */
export const InitialHostCommandScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("release"),
    ...scopeBinding,
    child: BootstrapAuditedProcessSchema,
    gate: z.strictObject({ fd: z.literal(3), protocol: z.literal("byte-1-then-eof-v1") }),
  }),
  z.strictObject({
    kind: z.literal("original-incumbent"),
    ...scopeBinding,
    selectedRelease: absolute,
    supervisor: DaemonMaintenanceProcessSchema,
    worker: DaemonMaintenanceProcessSchema,
  }),
  z.strictObject({
    kind: z.literal("candidate"),
    ...scopeBinding,
    directory: absolute,
    artifactSha256: digest,
  }),
]);
export type InitialHostCommandScope = z.infer<typeof InitialHostCommandScopeSchema>;
const recordBinding = {
  command: InitialHostCommandOperationSchema,
  stepId: z.uuid(),
  generation: z.uuid(),
  planSha256: digest,
  intentSha256: digest,
  claimSha256: digest,
  executor: BootstrapProcessIdentitySchema,
  scope: InitialHostCommandScopeSchema,
};
export const InitialHostCommandFenceSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("initial-host-command-attempt"),
  ...recordBinding,
});
export const InitialHostCommandQueueAttemptSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("initial-host-command-queue-attempt"),
  ...recordBinding,
  fenceSha256: digest,
  commandSha256: digest,
  channelSha256: digest,
});

function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(`Initial Host command attempt: ${message}`);
}
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
function sync(action: () => void) {
  requireProof(action() === undefined, "custody and enqueue must be synchronous");
}

function canonicalContext(
  context: InitialHostCommandContext,
  operation: InitialHostCommandOperation,
) {
  InitialHostCommandOperationSchema.parse(operation);
  requireProof(
    (operation === "release") === (context.actor === "release"),
    "operation does not match local actor",
  );
  const inspected = inspectInitialHostSupervisorMigrationPlan(context.plan);
  const intent = InitialHostMigrationIntentSchema.parse(context.intent);
  const claim = InitialHostMigrationClaimSchema.parse(context.claim);
  const executor = BootstrapProcessIdentitySchema.parse(context.executor);
  requireProof(intent.nativeLaunch, "native launch binding is required");
  inspectInitialHostNativeLaunchBinding(intent.nativeLaunch, {
    enrollmentStateDirectory: context.enrollmentStateDirectory,
    stepId: intent.stepId,
    generation: intent.generation,
  });
  requireProof(
    context.planSha256 === inspected.planSha256 &&
      intent.planSha256 === inspected.planSha256 &&
      intent.identitySha256 === inspected.plan.identitySha256 &&
      intent.preconditionSha256 === inspected.plan.preconditionSha256 &&
      claim.intentId === intent.id &&
      claim.intentSha256 === hash(intent) &&
      claim.planSha256 === inspected.planSha256 &&
      claim.stepId === intent.stepId &&
      claim.generation === intent.generation,
    "context differs from the exact consumed intent/claim",
  );
  requireProof(
    isDeepStrictEqual(
      executor,
      context.actor === "release" ? intent.nativeLaunch.coordinator.identity : claim.executor,
    ),
    "acting executor differs",
  );
  return { ...inspected, intent, claim, executor };
}

/** Pure canonical selectors, not native proof or queue authority. */
export function initialHostCommandScope(
  context: InitialHostCommandContext,
  operation: InitialHostCommandOperation,
): InitialHostCommandScope {
  const { plan, intent, claim } = canonicalContext(context, operation);
  const identity = plan.precondition.identity;
  requireProof(identity.environment === "host", "Host service identity is required");
  const common = {
    identitySha256: plan.identitySha256,
    preconditionSha256: plan.preconditionSha256,
    service: `${identity.serviceDomain}/${identity.serviceLabel}`,
  };
  if (operation === "release")
    return InitialHostCommandScopeSchema.parse({
      kind: "release",
      ...common,
      child: { identity: claim.executor, auditToken: claim.executorAuditToken },
      gate: intent.nativeLaunch!.gate,
    });
  if (operation === "bootstrap")
    return InitialHostCommandScopeSchema.parse({
      kind: "candidate",
      ...common,
      directory: plan.candidate.directory,
      artifactSha256: plan.candidate.artifactSha256,
    });
  return InitialHostCommandScopeSchema.parse({
    kind: "original-incumbent",
    ...common,
    selectedRelease: plan.precondition.selectedRelease,
    supervisor: plan.precondition.supervisor,
    worker: plan.precondition.worker,
  });
}
export function initialHostCommandPaths(
  context: InitialHostCommandContext,
  operation: InitialHostCommandOperation,
) {
  const directory = absolute.parse(context.enrollmentStateDirectory);
  const id = z.uuid().parse(context.intent.id);
  InitialHostCommandOperationSchema.parse(operation);
  return {
    fenceFile: path.join(directory, `initial-host-${operation}-attempt-${id}.json`),
    queueFile: path.join(directory, `initial-host-${operation}-queue-attempt-${id}.json`),
  };
}
function canonicalRecordBinding(
  context: InitialHostCommandContext,
  operation: InitialHostCommandOperation,
) {
  const { planSha256, intent, claim, executor } = canonicalContext(context, operation);
  return {
    command: operation,
    stepId: intent.stepId,
    generation: intent.generation,
    planSha256,
    intentSha256: hash(intent),
    claimSha256: hash(claim),
    executor,
    scope: initialHostCommandScope(context, operation),
  };
}
/** Keep writer byte order shared with producers and read-only observers. */
export function initialHostCommandFenceRecord(input: {
  context: InitialHostCommandContext;
  operation: InitialHostCommandOperation;
}) {
  return InitialHostCommandFenceSchema.parse({
    version: 1,
    operation: "initial-host-command-attempt",
    ...canonicalRecordBinding(input.context, input.operation),
  });
}
export function initialHostCommandQueueAttemptRecord(input: {
  context: InitialHostCommandContext;
  operation: InitialHostCommandOperation;
  fenceBytes: Uint8Array;
  command: object;
  channelIdentity: object;
}) {
  z.json().parse(input.command);
  z.json().parse(input.channelIdentity);
  return InitialHostCommandQueueAttemptSchema.parse({
    version: 1,
    operation: "initial-host-command-queue-attempt",
    ...canonicalRecordBinding(input.context, input.operation),
    fenceSha256: sha(input.fenceBytes),
    commandSha256: hash(input.command),
    channelSha256: hash(input.channelIdentity),
  });
}

/** The actual native owner binds its fixed command and measured channel to the
 * operation and context. These fields/callbacks are not a native proof factory. */
export interface InitialHostCommandOwner {
  operation: InitialHostCommandOperation;
  executor: z.infer<typeof BootstrapProcessIdentitySchema>;
  command: object;
  channel: object;
  channelIdentity: object;
  scope: InitialHostCommandScope;
  fence: { file: string; bytes: Uint8Array };
  assertCurrent(context: InitialHostCommandContext): void;
  enqueue(): void;
}
export interface InitialHostCommandAdmissionPorts {
  admit: typeof withInitialHostCommandAdmission;
}
const productionPorts: InitialHostCommandAdmissionPorts = {
  admit: withInitialHostCommandAdmission,
};
type Writes = Pick<EnrollmentWriteFiles, "open" | "write" | "sync" | "close">;

function retainActor(actor: InitialHostCommandActor) {
  const kind = actor.kind;
  const handle = actor.kind === "release" ? actor.constructorHandle : actor.claimedHandle;
  const channel = actor.kind === "release" ? actor.channel : null;
  const child = actor.kind === "release" ? actor.child : null;
  const retained = child && retainCustodyBinding(child, requireProof);
  return () => {
    requireProof(
      actor.kind === kind &&
        (actor.kind === "release" ? actor.constructorHandle : actor.claimedHandle) === handle,
      "local actor changed",
    );
    if (actor.kind === "release") {
      requireProof(
        actor.channel === channel && actor.child === child,
        "constructor channel/child changed",
      );
      retained!.check();
    }
  };
}
function assertSelf(executor: z.infer<typeof BootstrapProcessIdentitySchema>) {
  requireProof(
    executor.pid === process.pid &&
      executor.parentPid === process.ppid &&
      executor.uid === process.getuid?.() &&
      executor.executable === realpathSync(process.execPath),
    "native owner is not the actual acting process",
  );
}
function retainNative(owner: InitialHostCommandOwner) {
  const operation = InitialHostCommandOperationSchema.parse(owner.operation);
  const retained = retainCustodyBinding(
    {
      operation: owner.operation,
      executor: owner.executor,
      command: owner.command,
      channelIdentity: owner.channelIdentity,
      scope: owner.scope,
      fence: owner.fence,
    },
    requireProof,
  );
  const executor = owner.executor,
    command = owner.command,
    channel = owner.channel,
    channelIdentity = owner.channelIdentity,
    scope = owner.scope,
    fence = owner.fence,
    assertNative = owner.assertCurrent,
    enqueue = owner.enqueue;
  requireProof(
    channel !== null &&
      typeof channel === "object" &&
      command !== null &&
      typeof assertNative === "function" &&
      typeof enqueue === "function",
    "original native owner is required",
  );
  BootstrapProcessIdentitySchema.parse(retained.snapshot.executor);
  z.json().parse(retained.snapshot.command);
  z.json().parse(retained.snapshot.channelIdentity);
  requireProof(
    fence.bytes instanceof Uint8Array && fence.bytes.byteLength <= 1024 * 1024,
    "fence bytes are unavailable or oversized",
  );
  const check = () => {
    retained.check();
    assertSelf(retained.snapshot.executor);
    requireProof(
      owner.operation === operation &&
        owner.executor === executor &&
        owner.command === command &&
        owner.channel === channel &&
        owner.channelIdentity === channelIdentity &&
        owner.scope === scope &&
        owner.fence === fence &&
        owner.assertCurrent === assertNative &&
        owner.enqueue === enqueue,
      "native owner references changed",
    );
  };
  check();
  return { operation, snapshot: retained.snapshot, check, assertNative, enqueue, channel };
}
function retainFence(
  context: InitialHostCommandContext,
  operation: InitialHostCommandOperation,
  supplied: InitialHostCommandOwner["fence"],
) {
  const paths = initialHostCommandPaths(context, operation);
  const directory = context.enrollmentStateDirectory;
  const metadata = lstatSync(directory);
  requireProof(
    realpathSync(directory) === directory &&
      metadata.isDirectory() &&
      metadata.uid === process.getuid?.() &&
      (metadata.mode & 0o077) === 0,
    "state namespace is not private owned custody",
  );
  requireProof(supplied.file === paths.fenceFile, "prior fence is misaddressed");
  const parents = retainServiceFiles([directory, paths.fenceFile]);
  const stat = lstatSync(paths.fenceFile);
  requireProof(
    stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
    "prior fence is not private owned data",
  );
  const bytes = Buffer.from(supplied.bytes);
  const canonical = Buffer.from(
    JSON.stringify(initialHostCommandFenceRecord({ context, operation })),
  );
  requireProof(bytes.equals(canonical), "prior fence bytes differ from exact command binding");
  const contents = retainMaintenancePublishedFile(paths.fenceFile, bytes);
  return {
    paths,
    bytes,
    check() {
      parents();
      contents();
    },
  };
}

/** Two real admissions, one durable exclusive queue attempt, no default enqueue.
 * A return is only a synchronous queue attempt, never delivery or settlement.
 * Throws and post-action sync failure leave the addressed artifact unreplayable.
 * The injectable admission adapter exists for inert mechanics tests; production
 * uses the root local-handle/current-grant guard without a fake proof fallback. */
export function attemptInitialHostCommand(
  actor: InitialHostCommandActor,
  owner: InitialHostCommandOwner,
  files?: Writes,
  ports: InitialHostCommandAdmissionPorts = productionPorts,
): void {
  const native = retainNative(owner);
  requireProof(
    (native.operation === "release") === (actor.kind === "release"),
    "operation does not match actor",
  );
  requireProof(
    actor.kind !== "release" || actor.channel === native.channel,
    "release requires the constructor's actual channel",
  );
  const actorCurrent = retainActor(actor),
    admit = ports.admit,
    writes = files && { ...files };
  requireProof(typeof admit === "function", "admission is unavailable");
  let captured: ReturnType<typeof retainCustodyBinding<InitialHostCommandContext>> | undefined;
  let fence: ReturnType<typeof retainFence> | undefined;
  let attemptCurrent: (() => void) | undefined;
  const references = () => {
    actorCurrent();
    native.check();
    requireProof(ports.admit === admit, "admission callback changed");
  };
  const check = (context: InitialHostCommandContext) => {
    references();
    if (!captured) captured = retainCustodyBinding(context, requireProof);
    captured.check();
    requireProof(isDeepStrictEqual(context, captured.snapshot), "admission context changed");
    requireProof(
      isDeepStrictEqual(native.snapshot.executor, context.executor) &&
        isDeepStrictEqual(
          native.snapshot.scope,
          initialHostCommandScope(context, native.operation),
        ),
      "native executor/scope differs from admitted command",
    );
    if (!fence) fence = retainFence(context, native.operation, native.snapshot.fence);
    fence.check();
    attemptCurrent?.();
    sync(() => native.assertNative.call(owner, context));
    references();
    captured.check();
    requireProof(
      isDeepStrictEqual(context, captured.snapshot),
      "native callback changed admission context",
    );
    fence.check();
    attemptCurrent?.();
  };
  sync(() =>
    admit.call(ports, actor, check, (context, reassert) => {
      reassert();
      requireProof(fence && captured, "command fence is unavailable");
      const record = initialHostCommandQueueAttemptRecord({
        context: captured.snapshot,
        operation: native.operation,
        fenceBytes: fence.bytes,
        command: native.snapshot.command,
        channelIdentity: native.snapshot.channelIdentity,
      });
      writeInitialHostArtifact(
        context.enrollmentStateDirectory,
        fence.paths.queueFile,
        record,
        writes,
      );
      const parents = retainServiceFiles([context.enrollmentStateDirectory, fence.paths.queueFile]);
      const contents = retainMaintenancePublishedFile(
        fence.paths.queueFile,
        Buffer.from(JSON.stringify(record)),
      );
      attemptCurrent = () => {
        parents();
        contents();
      };
      reassert();
      attemptCurrent();
    }),
  );
  requireProof(fence && attemptCurrent, "durable queue attempt is unavailable");
  const retainedFence = fence,
    retainedAttempt = attemptCurrent;
  // Reopening meets O_EXCL in the first admission. It cannot reconstruct enqueue.
  let enqueueAttempted = false;
  sync(() =>
    admit.call(ports, actor, check, (_context, reassert) => {
      // LAST callback-bearing authority/custody check before the original enqueue.
      reassert();
      // Only original callback-free filesystem custody follows that policy check.
      retainedFence.check();
      retainedAttempt();
      requireProof(!enqueueAttempted, "local queue attempt was already used");
      enqueueAttempted = true;
      sync(() => Reflect.apply(native.enqueue, owner, []));
      references();
      retainedAttempt();
    }),
  );
}
