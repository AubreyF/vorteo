import { isDeepStrictEqual } from "node:util";
import { enrollmentManifestDigest } from "./authorization.js";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import type { InstallationEnrollmentState } from "@getpaseo/protocol/installation-enrollment";
import type { RestartApprovalPolicy, RestartJournal } from "../restarts.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import type { LifecycleActivationChild } from "../coordinator-bootstrap-maintenance-child.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import { FileEnrollmentJournal } from "./authorization.js";
import {
  assertStandingRestartAdmission,
  evaluateStandingRestart,
  type StandingRestartPhase,
} from "./restart-admission.js";

export interface StandingRestartEvidence {
  /** Obtained from independent native inspection, never copied from the manifest. */
  nativeIdentitySha256: string;
  repository: string | null;
}

export interface StandingRestartAdmissionPorts {
  /** Return null for missing, expired or changed native/source evidence. */
  evidence(job: RestartJob): StandingRestartEvidence | null;
  /** Synchronous protected evidence checks only. Native collection precedes admission. */
  assertEvidence(job: RestartJob, phase: StandingRestartPhase): void;
}

/** Reuses the existing queue and its shared kernel lock. Enrollment policy evaluation
 * alone never grants an effect, and unavailable evidence never falls back to legacy authority. */
export function createStandingRestartAdapter(input: {
  directory: string;
  installationId: string;
  credentialBindingSha256: string;
  ports: StandingRestartAdmissionPorts;
}) {
  const enrollment = new FileEnrollmentJournal(input.directory);
  const lifecycle = new FileBootstrapRequestJournal(input.directory);
  const evaluate = (job: RestartJob, state: InstallationEnrollmentState) => {
    if (state.status === "absent") return undefined;
    const evidence = input.ports.evidence(job);
    if (!evidence) return null;
    return evaluateStandingRestart({ ...input, ...evidence, state, job });
  };
  const standingDecision: NonNullable<RestartApprovalPolicy["standingDecision"]> = (job) => {
    const state = enrollment.readPolicySnapshot();
    const current = evaluate(job, state);
    if (current || current === undefined) return current;
    return retainAuthorizedDecision(job, state, input);
  };
  const journal: RestartJournal = {
    read: () => lifecycle.readLifecycle(),
    admissionAvailable: () => lifecycle.lifecycleAdmissionAvailable(),
    activationChildAdmissionAvailable: (job) => Boolean(standingDecision(job)?.activationStep),
    write: (jobs) => {
      const children = jobs.filter(
        (job): job is RestartJob =>
          (job.target === "host" || job.target === "container-daemon") &&
          Boolean(job.standingDecision?.activationStep) &&
          (job.status === "approved" || job.status === "running"),
      );
      if (children.length > 1)
        throw new BootstrapRequestConflict("Only one initial activation child may be admitted");
      const child = children[0];
      lifecycle.writeLifecycle(
        jobs,
        (previous, next) => {
          const state = enrollment.readUnderLifecycleLock();
          assertStandingRestartAdmission({ ...input.ports, previous, next, state, evaluate });
          // Initial candidates were built for the exact combined review. They must
          // remain bound even on an authenticated manual supersession of that child.
          const retainedChild = child
            ? previous.find(
                (job): job is RestartJob =>
                  (job.target === "host" || job.target === "container-daemon") &&
                  job.id === child.id,
              )
            : undefined;
          const childEffect =
            child &&
            (child.status !== retainedChild?.status ||
              !isDeepStrictEqual(child.standingDecision, retainedChild?.standingDecision) ||
              (!retainedChild?.standingHold && child.standingHold));
          if (childEffect) {
            const result: unknown = input.ports.assertEvidence(child, "replacement");
            if (result instanceof Promise)
              throw new BootstrapRequestConflict(
                "Activation evidence admission must be synchronous",
              );
          }
          return undefined;
        },
        child ? activationChild(child) : undefined,
      );
    },
  };
  return { journal, standingDecision };
}

function activationChild(job: RestartJob): LifecycleActivationChild {
  const decision = job.standingDecision!;
  const step = decision.activationStep!;
  return {
    grantId: decision.grantId,
    grantRevision: decision.grantRevision,
    manifestSha256: decision.manifestSha256,
    stepId: step.stepId,
    generation: step.generation,
    requestId: job.id,
    requestRevision: job.revision,
    planSha256: decision.planSha256,
    target: job.target,
  };
}

/** A temporary native-readiness failure must not revoke an unchanged private
 * authorization receipt. This policy-only result cannot pass locked admission:
 * evaluate() there still requires current independent evidence. */
function retainAuthorizedDecision(
  job: RestartJob,
  state: InstallationEnrollmentState,
  input: { installationId: string; credentialBindingSha256: string },
) {
  if (
    state.status !== "enrolled" ||
    job.status !== "approved" ||
    !job.automaticApproval ||
    !job.standingDecision
  )
    return null;
  const previous = job.standingDecision;
  if (previous.manifestSha256 !== enrollmentManifestDigest(state.grant.manifest)) return null;
  const expected = evaluateStandingRestart({
    ...input,
    state,
    job,
    nativeIdentitySha256: previous.targetIdentitySha256,
    repository: job.update ? state.grant.manifest.trustedRepositories[0] : null,
  });
  if (!expected || !isDeepStrictEqual({ ...expected, requestRevision: job.revision }, previous))
    return null;
  return expected;
}
