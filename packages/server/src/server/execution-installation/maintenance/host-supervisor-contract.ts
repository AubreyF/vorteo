/** Pure reviewed Host data contracts. Native collection and effect admission stay in their owning modules. */
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  BootstrapProcessIdentitySchema,
  CoordinatorBootstrapPlanSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { DaemonMaintenanceProcessSchema as RuntimeProcessSchema } from "@getpaseo/protocol/maintenance-interruption";
import { BootstrapRequestConflict } from "../coordinator-bootstrap-errors.js";
import {
  EnrollmentNativeIdentitySchema,
  enrollmentNativeIdentityDigest,
} from "./native-identity.js";
const SourceSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) });

const MigrationFileSchema = z.strictObject({
  path: z.string().startsWith("/").max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Initial service custody is deliberately not running-runtime provenance. The
 * incumbent's overwritten argv cannot establish its imported module graph. */
export const InitialHostSupervisorPreconditionSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("initial-host-supervisor-migration"),
  provenance: z.literal("service-custody-and-observed-files"),
  identity: EnrollmentNativeIdentitySchema,
  configuration: MigrationFileSchema,
  launcher: MigrationFileSchema,
  clientConfiguration: MigrationFileSchema,
  node: MigrationFileSchema,
  supervisorEntrypoint: MigrationFileSchema,
  workerEntrypoint: MigrationFileSchema,
  sourceReceipt: MigrationFileSchema,
  selectedRelease: z.string().startsWith("/").max(4096),
  sourceCommit: SourceSchema.shape.sourceCommit,
  serverId: z.string().min(1).max(200),
  workerInstanceId: z.string().min(1).max(200).nullable(),
  workerInstanceSupport: z.enum(["supported", "unsupported"]),
  hostEndpoint: z.string().min(1).max(4096),
  registration: z.strictObject({
    program: z.string().nullable(),
    arguments: z.array(z.string()).min(2).max(16),
    environment: z.record(z.string(), z.string()),
    loadedEnvironment: z.record(z.string(), z.string()),
  }),
  supervisor: RuntimeProcessSchema,
  worker: RuntimeProcessSchema,
});
export type InitialHostSupervisorPrecondition = z.infer<
  typeof InitialHostSupervisorPreconditionSchema
>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const InitialHostSupervisorMigrationPlanSchema = z.strictObject({
  version: z.literal(3),
  operation: z.literal("initial-host-supervisor-migration"),
  managedReleaseRoot: z.string().startsWith("/").max(4096),
  installationId: z.string().uuid(),
  identitySha256: digest,
  preconditionSha256: digest,
  precondition: InitialHostSupervisorPreconditionSchema,
  candidate: CoordinatorBootstrapPlanSchema.shape.candidate,
  fallback: CoordinatorBootstrapPlanSchema.shape.candidate,
  fallbackProvenance: z.strictObject({
    path: z.string().startsWith("/").max(4096),
    sha256: digest,
  }),
  interruption: z.strictObject({
    finishTurnsSeconds: z.number().int().min(1).max(3600),
    terminateGraceSeconds: z.number().int().min(1).max(300),
  }),
});
export type InitialHostSupervisorMigrationPlan = z.infer<
  typeof InitialHostSupervisorMigrationPlanSchema
>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requireMatch(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(message);
}

/** Exact reviewed declarations only. Native custody, runtime artifact integrity
 * and safe interruption must be independently established before any effect. */
export function inspectInitialHostSupervisorMigrationPlan(value: unknown) {
  const plan = InitialHostSupervisorMigrationPlanSchema.parse(value);
  const previous = plan.precondition;
  const identity = previous.identity;
  requireMatch(
    identity.environment === "host" &&
      identity.target === "host" &&
      identity.installationId === plan.installationId &&
      enrollmentNativeIdentityDigest(identity) === plan.identitySha256 &&
      hash(previous) === plan.preconditionSha256,
    "Initial Host migration changed its exact precondition or identity",
  );
  requireMatch(
    (previous.workerInstanceSupport === "unsupported") === (previous.workerInstanceId === null),
    "Initial Host migration has inconsistent worker capability evidence",
  );
  requireMatch(
    plan.candidate.directory !== plan.fallback.directory &&
      plan.candidate.artifactSha256 !== plan.fallback.artifactSha256,
    "Initial Host migration requires a distinct compatible fallback",
  );
  requireMatch(
    path.normalize(plan.managedReleaseRoot) === plan.managedReleaseRoot &&
      plan.candidate.directory.startsWith(plan.managedReleaseRoot + path.sep) &&
      identity.selectionPath !== null,
    "Initial Host migration changed its managed release root",
  );
  const launcherPaths = [
    previous.launcher.path,
    plan.candidate.launcher.path,
    plan.fallback.launcher.path,
  ];
  requireMatch(
    new Set(launcherPaths).size === launcherPaths.length &&
      plan.fallback.launcher.sha256 === previous.launcher.sha256,
    "Initial Host migration requires its original immutable persistent launcher",
  );
  for (const release of [plan.candidate, plan.fallback]) {
    requireMatch(
      path.posix.normalize(release.directory) === release.directory &&
        release.entrypoint.path ===
          path.join(release.directory, "packages/server/dist/scripts/supervisor-entrypoint.js") &&
        isDeepStrictEqual(release.node, previous.node) &&
        isDeepStrictEqual(release.configuration, previous.configuration),
      "Initial Host migration changed its startup or protected configuration",
    );
  }
  requireMatch(
    plan.fallback.sourceCommit === previous.sourceCommit &&
      plan.fallback.entrypoint.sha256 === previous.supervisorEntrypoint.sha256 &&
      previous.supervisorEntrypoint.path ===
        path.join(
          previous.selectedRelease,
          "packages/server/dist/scripts/supervisor-entrypoint.js",
        ) &&
      previous.workerEntrypoint.path ===
        path.join(
          previous.selectedRelease,
          "packages/server/dist/server/server/daemon-worker.js",
        ) &&
      previous.sourceReceipt.path ===
        path.join(previous.selectedRelease, ".installation-source.json"),
    "Initial Host migration changed its reviewed incumbent fallback",
  );
  return { plan, planSha256: hash(plan) };
}

export const InitialHostMigrationIntentSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  operation: z.literal("initial-host-supervisor-migration"),
  grantId: z.string().uuid(),
  grantRevision: z.string().uuid(),
  manifestSha256: digest,
  stepId: z.string().uuid(),
  generation: z.string().uuid(),
  planSha256: digest,
  identitySha256: digest,
  preconditionSha256: digest,
  observedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const InitialHostMigrationClaimSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("initial-host-supervisor-migration"),
  intentId: z.uuid(),
  intentSha256: digest,
  stepId: z.uuid(),
  generation: z.uuid(),
  planSha256: digest,
  executor: BootstrapProcessIdentitySchema,
  consumedAt: z.iso.datetime(),
});

/** Canonical byte records shared by publication, readiness and partial-state
 * recovery. This validates bindings only, without file reads or effect authority. */
export function initialHostPublicationRecords(input: {
  plan: unknown;
  intent: unknown;
  claim: unknown;
  enrollmentStateDirectory: string;
}) {
  const { plan, planSha256 } = inspectInitialHostSupervisorMigrationPlan(input.plan);
  const intent = InitialHostMigrationIntentSchema.parse(input.intent);
  const claim = InitialHostMigrationClaimSchema.parse(input.claim);
  const directory = input.enrollmentStateDirectory;
  requireMatch(
    path.isAbsolute(directory) &&
      path.normalize(directory) === directory &&
      directory !== "/" &&
      intent.planSha256 === planSha256 &&
      intent.identitySha256 === plan.identitySha256 &&
      intent.preconditionSha256 === plan.preconditionSha256 &&
      claim.intentId === intent.id &&
      claim.intentSha256 === hash(intent) &&
      claim.planSha256 === planSha256 &&
      claim.generation === intent.generation &&
      claim.stepId === intent.stepId,
    "Host publication differs from its exact claim",
  );
  const reservationSha256 = hash(claim);
  const phase = {
    file: path.join(directory, `initial-host-publication-${intent.id}.json`),
    record: {
      version: 1,
      intentId: intent.id,
      claimSha256: reservationSha256,
      generation: claim.generation,
      planSha256,
      slot: "candidate",
    },
  };
  const phaseSha256 = createHash("sha256").update(JSON.stringify(phase.record)).digest("hex");
  return {
    phase,
    launcherAttempt: {
      file: path.join(directory, `initial-host-launcher-attempt-${intent.id}.json`),
      record: {
        version: 1,
        reservationSha256,
        files: [
          {
            path: plan.precondition.launcher.path,
            previousSha256: plan.precondition.launcher.sha256,
            sha256: plan.candidate.launcher.sha256,
          },
          { path: phase.file, previousSha256: null, sha256: phaseSha256 },
        ],
      },
    },
    selectorAttempt: {
      file: path.join(directory, `initial-host-selector-attempt-${intent.id}.json`),
      record: {
        version: 1,
        operation: "release-link-selection",
        reservationSha256,
        link: plan.precondition.identity.selectionPath!,
        previous: plan.precondition.selectedRelease,
        candidate: plan.candidate.directory,
      },
    },
    launcher: {
      path: plan.precondition.launcher.path,
      original: plan.precondition.launcher.sha256,
      candidate: plan.candidate.launcher.sha256,
      fallback: plan.fallback.launcher.sha256,
    },
    selector: {
      path: plan.precondition.identity.selectionPath!,
      original: plan.precondition.selectedRelease,
      candidate: plan.candidate.directory,
      fallback: plan.fallback.directory,
    },
  };
}
