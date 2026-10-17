import path from "node:path";
import { lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { EnrollmentStep, HostContinuation } from "@getpaseo/protocol/installation-enrollment";
import type { InstallationConfig } from "../config.js";
import { inspectMaintenanceObservationRuntime } from "../coordinator-bootstrap-maintenance-observation-runtime.js";
import { readEnrollmentNativeIdentity } from "./native-registration.js";
import {
  collectInitialHostCandidate,
  observeInitialHostMigrationTransition,
  readInitialHostRetainedClaim,
} from "./host-supervisor-execution.js";
import {
  initialHostObservationPending,
  inspectInitialHostRecoveryPublication,
  readInitialHostObservation,
} from "./host-supervisor-recovery-inspection.js";
import {
  BootstrapRequestConflict,
  assertCoordinatorLifecycleIdle,
  openBootstrapRequests,
} from "../coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { readProtectedDocument } from "../coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import {
  FileEnrollmentJournal,
  enrollmentManifestDigest,
  reserveActivationStep,
} from "./authorization.js";
import {
  inspectInitialHostSupervisorMigrationPlan,
  reserveInitialHostMigrationIntent,
  assertInitialHostIntentProofs,
} from "./host-supervisor-migration.js";

type IntentInput = Parameters<typeof reserveInitialHostMigrationIntent>[0];
interface HostActivationInvocation {
  enrollmentStateDirectory: string;
  plan: IntentInput["plan"];
  grantId: string;
  grantRevision: string;
  stepId: string;
  generation: string;
}

export interface HostContinuationObservationInvocation extends HostActivationInvocation {
  role: "restoration" | "candidate";
  lineage: HostContinuation;
}

export interface InitialHostActivationPorts {
  /** This must establish the admitted executor and interruption prerequisites
   * before reservation. An unavailable production proof leaves work pending. */
  prepare(plan: IntentInput["plan"]): Promise<{
    native: IntentInput["native"];
    artifacts: IntentInput["artifacts"];
    assertCurrent(): void;
    launch(input: HostActivationInvocation): Promise<unknown>;
  }>;
  /** No constructor, launch or fresh effect proof is reachable from this port.
   * The observer verifies exact executor exit before target artifact reads. */
  observe(input: HostActivationInvocation): Promise<unknown>;
  /** Read-only continuation observation. Missing native composition leaves the
   * retained generation unresolved; it never falls back to initial migration. */
  observeContinuation?(input: HostContinuationObservationInvocation): Promise<unknown>;
}

export type InitialHostActivationResult = "idle" | "verified" | "unresolved";

/** The installed caller can observe retained work without constructing an
 * effect executor. Fresh migration remains unavailable until interruption and
 * immutable child-launch custody have production implementations. */
export async function reconcileNativeInitialHostActivation(input: {
  configuration: InstallationConfig;
  configurationFile: string;
}): Promise<InitialHostActivationResult> {
  if (initialHostObservationPending()) return "unresolved";
  const { configuration } = input;
  const journal = new FileEnrollmentJournal(configuration.stateDir);
  const state = journal.readPolicySnapshot();
  if (state.status === "absent") return "idle";
  const hostStep = state.grant.manifest.steps.some(
    (step) => step.target === "host" && step.operation === "replacement",
  );
  if (!hostStep) return "idle";
  const target = state.grant.manifest.targets.find((entry) => entry.target === "host");
  requireMatch(target, "Initial Host enrolled identity is missing");
  const identity = readEnrollmentNativeIdentity(configuration.stateDir, target.identitySha256);
  requireMatch(
    identity.environment === "host" &&
      identity.target === "host" &&
      identity.installationId === configuration.public.installationId &&
      identity.stateDirectory === configuration.host.startupValidation?.home &&
      `${identity.serviceDomain}/${identity.serviceLabel}` === configuration.host.launchdService,
    "Initial Host identity differs from current configuration",
  );
  const assertIdentity = () => {
    requireMatch(
      isDeepStrictEqual(
        identity,
        readEnrollmentNativeIdentity(configuration.stateDir, target.identitySha256),
      ),
      "Initial Host identity changed during observation",
    );
  };
  return reconcileInitialHostActivation(
    {
      installationId: configuration.public.installationId,
      installationRoot: identity.installationRoot,
      stateDirectory: configuration.stateDir,
    },
    {
      async prepare() {
        throw new BootstrapRequestConflict(
          "Initial Host production interruption and child-launch custody are unavailable",
        );
      },
      async observe(invocation) {
        const inspected = inspectInitialHostSupervisorMigrationPlan(invocation.plan);
        requireMatch(
          isDeepStrictEqual(inspected.plan.precondition.identity, identity) &&
            inspected.plan.precondition.configuration.path === input.configurationFile,
          "Initial Host observation differs from configured identity",
        );
        const anchor = await readInitialHostObservation(() =>
          inspectMaintenanceObservationRuntime(input),
        );
        requireMatch(
          anchor.installationRoot === identity.installationRoot,
          "Initial Host and coordinator observation roots differ",
        );
        assertIdentity();
        anchor.assertCurrent();
        const publication = await inspectInitialHostRecoveryPublication({
          retained: readInitialHostRetainedClaim(invocation),
          reader: anchor.ports.reader,
          writableMountRoots: anchor.writableMountRoots,
          signal: new AbortController().signal,
          assertAnchorCurrent() {
            anchor.assertCurrent();
            assertIdentity();
          },
        });
        publication.assertCurrent();
        if (publication.publication.classification !== "completed-candidate")
          return publication.publication;
        return observeInitialHostMigrationTransition(invocation, {
          reader: anchor.ports.reader,
          async collectCandidate(context, signal) {
            const collected = await readInitialHostObservation(() =>
              collectInitialHostCandidate(context, anchor.writableMountRoots, signal),
            );
            const assertSelection = () => {
              publication.assertCurrent();
              anchor.assertCurrent();
              assertIdentity();
              requireMatch(
                collected.assertSelection() === undefined,
                "Initial Host candidate observation must remain synchronous",
              );
              anchor.assertCurrent();
              assertIdentity();
              publication.assertCurrent();
            };
            assertSelection();
            return { ...collected, assertSelection };
          },
        });
      },
    },
  );
}

/** Called by the selected coordinator's existing drain, never a second timer or
 * queue. Only the caller that reserves a pending step may launch its child. */
export async function reconcileInitialHostActivation(
  input: { installationRoot: string; stateDirectory: string; installationId: string },
  ports: InitialHostActivationPorts,
): Promise<InitialHostActivationResult> {
  const journal = new FileEnrollmentJournal(input.stateDirectory);
  const state = journal.read();
  if (state.status === "absent") return "idle";
  const manifest = state.grant.manifest;
  const steps = manifest.steps.filter(
    (step) => step.target === "host" && step.operation === "replacement",
  );
  if (steps.length === 0) return "idle";
  requireMatch(steps.length === 1, "Initial Host activation is ambiguous");
  const step = steps[0]!;
  const progress = state.activation.steps.find((entry) => entry.id === step.id)!;
  const lineage = state.activation.hostContinuations?.find((entry) => entry.stepId === step.id);
  if (progress.status === "succeeded" && !lineage) return "verified";
  requireMatch(
    manifest.installationId === input.installationId &&
      state.grant.approval.manifestSha256 === enrollmentManifestDigest(manifest),
    "Initial Host activation belongs to another installation",
  );
  if (progress.status === "pending") {
    const authorized =
      !state.grant.paused &&
      state.grant.revokedAt === null &&
      !state.grant.disabledTargets.includes("host");
    const ready = step.dependsOn.every((id) =>
      state.activation.steps.some((entry) => entry.id === id && entry.status === "succeeded"),
    );
    if (!authorized || !ready) return "idle";
  }
  const planFile = path.join(
    input.installationRoot,
    "initial-host-migrations",
    "plans",
    `${step.planSha256}.json`,
  );
  const files = retainServiceFiles([planFile]);
  const inspected = inspectInitialHostSupervisorMigrationPlan(
    JSON.parse((await readProtectedDocument(planFile)).toString("utf8")),
  );
  const target = manifest.targets.find((entry) => entry.target === "host");
  requireHostPlan(input, step, target?.identitySha256, inspected);
  requireMatch(
    isDeepStrictEqual(manifest.interruption, inspected.plan.interruption),
    "Initial Host interruption differs from enrollment",
  );
  const assertRetained = () => {
    files();
    requireMatch(
      inspectInitialHostSupervisorMigrationPlan(inspected.plan).planSha256 === step.planSha256,
      "Initial Host activation plan changed",
    );
    requireMatch(
      isDeepStrictEqual(manifest.interruption, inspected.plan.interruption),
      "Initial Host interruption differs from enrollment",
    );
    const current = journal.readPolicySnapshot();
    requireMatch(
      current.status === "enrolled" &&
        current.grant.id === state.grant.id &&
        isDeepStrictEqual(current.grant.manifest, manifest) &&
        isDeepStrictEqual(current.grant.approval, state.grant.approval),
      "Initial Host activation enrollment changed",
    );
  };
  assertRetained();
  if (lineage)
    return observeRetainedContinuation({
      journal,
      lineage,
      ports,
      assertRetained,
      invocation: {
        enrollmentStateDirectory: input.stateDirectory,
        plan: inspected.plan,
        grantId: state.grant.id,
        stepId: step.id,
      },
    });
  if (progress.status !== "pending") {
    const claimFile = path.join(
      input.stateDirectory,
      `initial-host-claim-${step.id}-${progress.generation}.json`,
    );
    if (!filePresent(claimFile)) return "unresolved";
    await ports.observe({
      enrollmentStateDirectory: input.stateDirectory,
      plan: inspected.plan,
      grantId: state.grant.id,
      grantRevision: progress.grantRevision,
      stepId: step.id,
      generation: progress.generation,
    });
    assertRetained();
    return verified(journal, step.id, progress.generation);
  }
  const prepared = await ports.prepare(inspected.plan);
  assertRetained();
  const bootstrap = new FileBootstrapRequestJournal(input.stateDirectory);
  const reserved = reserveActivationStep(journal, {
    grantRevision: state.grant.revision,
    stepId: step.id,
    assertCurrent() {
      assertRetained();
      requireMatch(
        openBootstrapRequests(bootstrap.read()).length === 0,
        "Coordinator work conflicts with initial Host reservation",
      );
      assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
      requireMatch(
        prepared.assertCurrent() === undefined,
        "Host activation prerequisite custody must be synchronous",
      );
      assertInitialHostIntentProofs(prepared, inspected.plan, inspected.planSha256);
      assertRetained();
      requireMatch(
        openBootstrapRequests(bootstrap.read()).length === 0,
        "Coordinator work conflicts with initial Host reservation",
      );
      assertCoordinatorLifecycleIdle(bootstrap.readLifecycle());
    },
  });
  requireMatch(reserved.status === "enrolled", "Initial Host reservation disappeared");
  const selected = reserved.activation.steps.find((entry) => entry.id === step.id);
  requireMatch(selected?.status === "reserved", "Initial Host reservation changed");
  const invocation = {
    enrollmentStateDirectory: input.stateDirectory,
    plan: inspected.plan,
    grantId: state.grant.id,
    grantRevision: selected.grantRevision,
    stepId: step.id,
    generation: selected.generation,
  };
  reserveInitialHostMigrationIntent({
    ...invocation,
    native: prepared.native,
    artifacts: prepared.artifacts,
  });
  await prepared.launch(invocation);
  assertRetained();
  return verified(journal, step.id, selected.generation);
}

async function observeRetainedContinuation(input: {
  journal: FileEnrollmentJournal;
  lineage: HostContinuation;
  ports: InitialHostActivationPorts;
  assertRetained(): void;
  invocation: Omit<HostActivationInvocation, "grantRevision" | "generation">;
}): Promise<InitialHostActivationResult> {
  const { journal, lineage, ports, assertRetained } = input;
  const role = lineage.candidate ? "candidate" : "restoration";
  const child = lineage.candidate ?? lineage.restoration;
  if (role === "candidate" && child.observation?.outcome === "candidate-ready")
    return verified(journal, lineage.stepId, child.generation);
  // A reservation does not identify a born executor. Terminal restoration is
  // likewise not permission to launch or complete the candidate generation.
  const observe = ports.observeContinuation;
  if (!child.claim || child.observation || !observe) return "unresolved";
  const invocation: HostContinuationObservationInvocation = {
    ...structuredClone(input.invocation),
    grantRevision: child.grantRevision,
    generation: child.generation,
    role,
    lineage: structuredClone(lineage),
  };
  const retained = structuredClone(invocation);
  await observe.call(ports, invocation);
  requireMatch(
    ports.observeContinuation === observe && isDeepStrictEqual(invocation, retained),
    "Host continuation observation binding changed",
  );
  assertRetained();
  return role === "candidate" ? verified(journal, lineage.stepId, child.generation) : "unresolved";
}

function requireHostPlan(
  input: { installationId: string; installationRoot: string },
  step: EnrollmentStep,
  identitySha256: string | undefined,
  inspected: ReturnType<typeof inspectInitialHostSupervisorMigrationPlan>,
) {
  const { plan, planSha256 } = inspected;
  const artifact = (release: typeof plan.candidate) => ({
    sourceCommit: release.sourceCommit,
    artifactSha256: release.artifactSha256,
  });
  requireMatch(
    planSha256 === step.planSha256 &&
      plan.identitySha256 === identitySha256 &&
      plan.installationId === input.installationId &&
      plan.precondition.identity.installationRoot === input.installationRoot &&
      isDeepStrictEqual(step.candidate, artifact(plan.candidate)) &&
      isDeepStrictEqual(step.previous, artifact(plan.fallback)),
    "Initial Host plan differs from its addressed enrollment step",
  );
}

function verified(journal: FileEnrollmentJournal, stepId: string, generation: string) {
  const state = journal.read();
  const step =
    state.status === "enrolled" && state.activation.steps.find((entry) => entry.id === stepId);
  return step && step.status === "succeeded" && step.generation === generation
    ? "verified"
    : "unresolved";
}

function filePresent(file: string) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function requireMatch(value: unknown, detail: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(detail);
}
