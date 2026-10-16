import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { StandingInterruptionSchema } from "@getpaseo/protocol/maintenance-interruption";
import type { RestartJob, RestartImpact } from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "../config.js";
import type { InstallationSourceUpdates } from "../source-updates.js";
import type { RestartExecutor } from "../restarts.js";
import { FileEnrollmentJournal } from "./authorization.js";
import { readEnrollmentNativeIdentity } from "./native-registration.js";
import {
  inspectEnrollmentDaemonIdentity,
  type EnrollmentDaemonObservation,
} from "./native-daemon-inspection.js";
import { createStandingRestartAdapter } from "./restart-adapter.js";
import { standingRestartPlanDigest } from "./restart-admission.js";
import type { EnrollmentServiceObservation } from "./status.js";

const FRESHNESS_MS = 30_000;
interface SourceEvidence {
  planSha256: string;
  repository: string | null;
  assertCurrent(): void;
}
interface DaemonStandingPorts {
  inspect: typeof inspectEnrollmentDaemonIdentity;
  now(): number;
}
type StandingUpdater = Pick<
  InstallationSourceUpdates,
  | "inspectStandingSource"
  | "assertStandingPrepared"
  | "verifyPreparedInstallation"
  | "standingCandidate"
>;

/** Collects evidence on the coordinator's existing drain cycle. It creates no
 * worker, lifecycle queue, durable store or independent polling loop. */
export function createDaemonStandingRuntime(
  config: InstallationConfig,
  updates: Record<RestartJob["target"], StandingUpdater | null>,
  ports: DaemonStandingPorts = { inspect: inspectEnrollmentDaemonIdentity, now: Date.now },
) {
  const enrollment = new FileEnrollmentJournal(config.stateDir);
  const native = new Map<RestartJob["target"], EnrollmentDaemonObservation>();
  const sources = new Map<string, SourceEvidence>();
  const admittedInstances = new Map<string, string>();
  let refreshing: Promise<void> | null = null;
  let refreshedAt = -Infinity;
  const credentialBindingSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        installation: config.public.installationId,
        host: config.hostAgentTokenHash,
        container: config.containerAgentTokenHash,
        owner: config.ownerPasswordHash,
      }),
    )
    .digest("hex");

  function observation(target: RestartJob["target"]) {
    const result = native.get(target);
    if (!result) return null;
    const age = ports.now() - Date.parse(result.observedAt);
    return age >= 0 && age < FRESHNESS_MS ? result : null;
  }
  function evidence(job: RestartJob) {
    // Supervisor replacement has its own native admission. A daemon observation
    // must never impersonate the supervisor's enrolled stable identity.
    if (job.supervisorPlanSha256) return null;
    const current = observation(job.target);
    if (!current) return null;
    try {
      const result: unknown = current.assertCurrent();
      if (result instanceof Promise) throw new Error("Native custody recheck must be synchronous");
    } catch {
      native.delete(job.target);
      return null;
    }
    if (!job.update) return { nativeIdentitySha256: current.identitySha256, repository: null };
    const source = sources.get(job.id);
    if (!source || source.planSha256 !== standingRestartPlanDigest(job)) return null;
    try {
      source.assertCurrent();
    } catch {
      sources.delete(job.id);
      return null;
    }
    return { nativeIdentitySha256: current.identitySha256, repository: source.repository };
  }
  function instance(current: EnrollmentDaemonObservation) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          identity: current.identitySha256,
          server: current.serverId,
          supervisor: current.supervisor,
          worker: current.worker,
        }),
      )
      .digest("hex");
  }
  const adapter = createStandingRestartAdapter({
    directory: config.stateDir,
    installationId: config.public.installationId,
    credentialBindingSha256,
    ports: {
      evidence,
      assertEvidence(job, phase) {
        if (!evidence(job)) throw new Error("Current native maintenance evidence is unavailable");
        if (job.standingInterruption) assertInterruptionEvidence(job);
        const initial = job.standingHold?.initialDaemonInstanceSha256;
        if (initial && instance(observation(job.target)!) !== initial)
          throw new Error("Initial daemon lifetime changed before dispatch");
        if (phase !== "preparation" && job.update) {
          const updater = updates[job.target];
          if (!updater) throw new Error("Standing source updater is unavailable");
          updater.assertStandingPrepared(job);
        }
        if (phase === "replacement" && job.status === "running")
          admittedInstances.set(job.id, instance(observation(job.target)!));
      },
    },
  });

  function assertInterruptionEvidence(job: RestartJob): void {
    const current = observation(job.target);
    const intent = job.standingInterruption;
    if (
      !current ||
      !intent ||
      current.workerInstanceId !== intent.held.workerInstanceId ||
      current.restartDrainId !== job.id
    )
      throw new Error("Interruption worker lifetime differs from current native inspection");
    const expected = StandingInterruptionSchema.shape.native.parse({
      identitySha256: current.identitySha256,
      serverId: current.serverId,
      sourceCommit: current.sourceCommit,
      selectedRelease: current.selectedRelease,
      observedAt: current.observedAt,
      supervisor: current.supervisor,
      worker: current.worker,
    });
    if (JSON.stringify(expected) !== JSON.stringify(intent.native))
      throw new Error("Interruption native evidence differs from locked admission");
    if (job.update) {
      const updater = updates[job.target];
      if (!updater || !isDeepStrictEqual(updater.standingCandidate(job), intent.candidate))
        throw new Error("Interruption candidate differs from verified preparation");
    }
  }

  async function collect(jobs: readonly RestartJob[]) {
    const state = enrollment.readPolicySnapshot();
    if (state.status === "absent") {
      native.clear();
      sources.clear();
      return;
    }
    await Promise.all(
      (["host", "container-daemon"] as const).map(async (target) => {
        native.delete(target);
        const binding = state.grant.manifest.targets.find((item) => item.target === target);
        if (!binding) return;
        try {
          const expected = readEnrollmentNativeIdentity(config.stateDir, binding.identitySha256);
          const current = await ports.inspect(config, expected);
          if (current.identitySha256 !== binding.identitySha256)
            throw new Error("Observed daemon identity differs from enrollment");
          native.set(target, current);
        } catch {
          // Missing evidence is unknown health and denied authority. Never reuse
          // a successful observation after a failed refresh.
          native.delete(target);
        }
      }),
    );
    sources.clear();
    for (const job of jobs) {
      if (!job.update || !["pending", "approved", "running"].includes(job.status)) continue;
      const current = observation(job.target);
      const updater = updates[job.target];
      if (!current || !updater) continue;
      try {
        const source = await updater.inspectStandingSource(job, current.writableMountRoots);
        sources.set(job.id, { ...source, planSha256: standingRestartPlanDigest(job) });
        const initial = adapter.standingDecision(job);
        if (job.status === "pending" && initial?.activationStep)
          await updater.verifyPreparedInstallation({
            ...job,
            standingDecision: { ...initial, requestRevision: job.revision },
          });
      } catch {
        sources.delete(job.id);
      }
    }
    refreshedAt = ports.now();
  }
  async function refresh(jobs: readonly RestartJob[], force = false) {
    // A forced caller needs evidence collected after its boundary, not merely
    // a collection that finishes afterwards. Serialize with any older collector.
    if (refreshing) {
      await refreshing;
      if (force) return refresh(jobs, true);
      return;
    }
    if (!force && ports.now() - refreshedAt < 10_000) return;
    refreshing = collect(jobs).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function initialActivationInstance(job: RestartJob): Promise<string> {
    if (!job.standingDecision?.activationStep)
      throw new Error("Legacy hold admission is limited to initial activation");
    await refresh([job], true);
    const current = observation(job.target);
    if (!current || !evidence(job)) throw new Error("Initial native identity is unverified");
    return instance(current);
  }
  function interruptionEvidence(job: RestartJob) {
    const state = enrollment.readPolicySnapshot();
    const current = observation(job.target);
    const hold = job.standingHold;
    const decision = job.standingDecision;
    if (
      state.status !== "enrolled" ||
      state.grant.paused ||
      state.grant.revokedAt ||
      state.grant.disabledTargets.includes(job.target) ||
      !decision ||
      decision.grantRevision !== state.grant.revision ||
      !hold?.observedAt ||
      hold.releaseRequestedAt ||
      hold.initialDaemonInstanceSha256 ||
      !current?.workerInstanceId ||
      current.restartDrainId !== job.id ||
      !evidence(job)
    )
      throw new Error("Current enrollment and exact native hold evidence are required");
    return { state, current, hold, decision, holdObservedAt: hold.observedAt };
  }
  async function prepareInterruption(job: RestartJob) {
    if (job.status !== "approved" || job.standingInterruption)
      throw new Error("Interruption preparation requires an undispatched approved request");
    await refresh([job], true);
    const { state, current, hold, decision, holdObservedAt } = interruptionEvidence(job);
    const candidate = job.update ? updates[job.target]?.standingCandidate(job) : null;
    if (job.update && !candidate) throw new Error("Verified interruption candidate is unavailable");
    const reserved = ports.now();
    const limits = state.grant.manifest.interruption;
    const finish = Date.parse(holdObservedAt) + limits.finishTurnsSeconds * 1000;
    const terminateAt = Math.min(reserved, finish) + limits.terminateGraceSeconds * 1000;
    if (terminateAt <= reserved)
      throw new Error("Interruption deadline has elapsed; fresh owner review is required");
    return StandingInterruptionSchema.parse({
      held: {
        requestId: job.id,
        generation: randomUUID(),
        workerPid: current.worker.pid,
        workerInstanceId: current.workerInstanceId,
        terminateAt,
      },
      approvedRevision: job.revision,
      grantRevision: state.grant.revision,
      holdGeneration: hold.generation,
      decisionSha256: createHash("sha256").update(JSON.stringify(decision)).digest("hex"),
      planSha256: standingRestartPlanDigest(job),
      reservedAt: new Date(reserved).toISOString(),
      finishDeadlineAt: new Date(finish).toISOString(),
      native: {
        identitySha256: current.identitySha256,
        serverId: current.serverId,
        sourceCommit: current.sourceCommit,
        selectedRelease: current.selectedRelease,
        observedAt: current.observedAt,
        supervisor: current.supervisor,
        worker: current.worker,
      },
      candidate,
    });
  }
  async function verifySelection(job: RestartJob, executor: RestartExecutor): Promise<void> {
    if (!job.standingDecision) return;
    await refresh([job], true);
    const current = observation(job.target);
    const hold = job.standingHold;
    if (
      !current ||
      !evidence(job) ||
      current.identitySha256 !== job.standingDecision.targetIdentitySha256 ||
      admittedInstances.get(job.id) !== instance(current)
    )
      throw new Error("Enrolled target lifetime changed after running admission");
    // The updater independently verifies the exact built candidate first. A
    // manual override can authorize interruption, never a different target/source.
    if (!job.automaticApproval && !job.whenIdle) return;
    if (!hold || !executor.inspect)
      throw new Error("Standing selection requires current hold evidence");
    if (hold.initialDaemonInstanceSha256) {
      if (
        !job.standingDecision.activationStep ||
        !hold.acknowledgedAt ||
        hold.initialDaemonInstanceSha256 !== instance(current)
      )
        throw new Error("Initial daemon lifetime changed before selection");
    }
    const impact = await executor.inspect(job.target);
    assertSelectionImpact(job, impact);
  }
  function observations(): EnrollmentServiceObservation[] {
    return [...native.keys()].flatMap((target) => {
      const current = observation(target);
      return current
        ? [
            {
              target,
              identitySha256: current.identitySha256,
              observedAt: current.observedAt,
              readiness: "ready" as const,
              reason: "Native registration, selected runtime and authenticated daemon verified.",
              selectedSource: current.sourceCommit,
            },
          ]
        : [];
    });
  }
  return {
    ...adapter,
    refresh,
    initialActivationInstance,
    prepareInterruption,
    verifySelection,
    observations,
  };
}

function assertSelectionImpact(job: RestartJob, impact: RestartImpact): void {
  const legacy = Boolean(job.standingHold?.initialDaemonInstanceSha256);
  const observedHold = impact.restartDrainObservationSupported && impact.restartDrainId === job.id;
  if (
    impact.error ||
    !impact.idleRestartSupported ||
    impact.agents.length ||
    impact.pendingStarts ||
    (!legacy && !observedHold)
  )
    throw new Error("Target is not prepared and held for the exact source selection");
}
