import {
  InstallationEnrollmentStatusSchema,
  type EnrollmentTarget,
  type InstallationEnrollmentState,
  type InstallationEnrollmentStatus,
} from "@getpaseo/protocol/installation-enrollment";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";

export interface EnrollmentServiceObservation extends Omit<
  InstallationEnrollmentStatus["services"][number],
  "enabled"
> {
  identitySha256: string;
}

interface EnrollmentStatusInput {
  installationId: string;
  state: InstallationEnrollmentState;
  checkedAt: string;
  observations: EnrollmentServiceObservation[];
  freshnessMs: number;
}

/** A terminal activation receipt is historical evidence, not current runtime health. */
export function projectEnrollmentStatus(
  input: EnrollmentStatusInput,
): InstallationEnrollmentStatus {
  const base = {
    version: 1 as const,
    installationId: input.installationId,
    checkedAt: input.checkedAt,
  };
  if (input.state.status === "absent") {
    return InstallationEnrollmentStatusSchema.parse({
      ...base,
      authority: "not-enrolled",
      grantRevision: null,
      activation: "not-enrolled",
      completedSteps: 0,
      totalSteps: 0,
      services: [],
      steps: [],
    });
  }
  const { grant, activation } = input.state;
  if (grant.manifest.installationId !== input.installationId)
    throw new BootstrapRequestConflict("Enrollment status belongs to a different installation");
  const observations = new Map<EnrollmentTarget, EnrollmentServiceObservation>();
  for (const observation of input.observations) {
    if (observations.has(observation.target))
      throw new BootstrapRequestConflict("Service status contains duplicate target observations");
    observations.set(observation.target, observation);
  }
  const checkedAt = Date.parse(input.checkedAt);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(input.freshnessMs) || input.freshnessMs < 0)
    throw new BootstrapRequestConflict("Service status requires a bounded observation time");
  const services = grant.manifest.targets.map((binding) => {
    const target = binding.target;
    const observation = observations.get(target);
    const enabled = !grant.revokedAt && !grant.paused && !grant.disabledTargets.includes(target);
    const unavailable = {
      target,
      enabled,
      readiness: "unknown" as const,
      reason: "Current service readiness has not been verified.",
      observedAt: null,
      selectedSource: null,
    };
    if (!observation || observation.observedAt === null) return unavailable;
    const age = checkedAt - Date.parse(observation.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > input.freshnessMs)
      return { ...unavailable, reason: "The last service observation is stale; refresh status." };
    if (observation.identitySha256 !== binding.identitySha256)
      return {
        ...unavailable,
        readiness: "blocked" as const,
        reason: "Observed service identity differs from its enrolled target.",
      };
    const { identitySha256: _identity, ...publicObservation } = observation;
    return { ...publicObservation, enabled };
  });
  const steps: InstallationEnrollmentStatus["steps"] = activation.steps.map((progress, index) => {
    const plan = grant.manifest.steps[index];
    if (progress.id !== plan.id)
      throw new BootstrapRequestConflict("Activation status ordering differs from its manifest");
    let status: InstallationEnrollmentStatus["steps"][number]["status"] = "pending";
    let observedAt: string | null = null;
    if (progress.status === "reserved") status = "unconfirmed";
    if (progress.status === "recovery_required") status = "recovery-required";
    if (progress.status === "succeeded") status = "verified";
    if (progress.status === "succeeded" || progress.status === "recovery_required")
      observedAt = progress.observedAt;
    return {
      id: plan.id,
      target: plan.target,
      status,
      observedAt,
      sourceCommit: plan.candidate.sourceCommit,
    };
  });
  const completedSteps = steps.filter((step) => step.status === "verified").length;
  let activationStatus: InstallationEnrollmentStatus["activation"] = "pending";
  if (completedSteps === steps.length) activationStatus = "verified";
  if (steps.some((step) => step.status === "unconfirmed")) activationStatus = "unconfirmed";
  if (steps.some((step) => step.status === "recovery-required"))
    activationStatus = "recovery-required";
  let authority: InstallationEnrollmentStatus["authority"] = "active";
  if (grant.paused) authority = "paused";
  if (grant.revokedAt) authority = "revoked";
  return InstallationEnrollmentStatusSchema.parse({
    ...base,
    validUntil: new Date(
      Math.min(
        checkedAt + input.freshnessMs,
        ...services.flatMap((service) =>
          service.observedAt ? [Date.parse(service.observedAt) + input.freshnessMs] : [],
        ),
      ),
    ).toISOString(),
    authority,
    grantRevision: grant.revision,
    activation: activationStatus,
    completedSteps,
    totalSteps: steps.length,
    services,
    steps,
  });
}
