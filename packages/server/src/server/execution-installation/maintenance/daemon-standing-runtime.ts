import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { StandingInterruptionSchema } from "@getpaseo/protocol/maintenance-interruption";
import type { RestartJob, RestartImpact } from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "../config.js";
import type { InstallationSourceUpdates } from "../source-updates.js";
import type { RestartExecutor } from "../restarts.js";
import { retainCustodyBinding, retainCustodyProof } from "../retained-custody-binding.js";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
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
  | "verifyInstalledInterruption"
>;

/** Collects evidence on the coordinator's existing drain cycle. It creates no
 * worker, lifecycle queue, durable store or independent polling loop. */
export function createDaemonStandingRuntime(
  config: InstallationConfig,
  updates: Record<RestartJob["target"], StandingUpdater | null>,
  ports: DaemonStandingPorts = { inspect: inspectEnrollmentDaemonIdentity, now: Date.now },
) {
  const registrationRequired = config.container.persistentRegistration !== undefined;
  const configuration = retainCustodyBinding(config, requireRegistration);
  const inspectionPorts = retainCustodyBinding(ports, requireRegistration);
  const clock = ports.now;
  const enrollment = new FileEnrollmentJournal(config.stateDir);
  const native = new Map<RestartJob["target"], EnrollmentDaemonObservation>();
  let registrationObservation: EnrollmentDaemonObservation | null = null;
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

  function requireRegistration(value: unknown, message: string): asserts value {
    if (!value) throw new BootstrapRequestConflict(`Dev registration readiness: ${message}`);
  }
  function retainRegistration(current: EnrollmentDaemonObservation) {
    const proof = retainCustodyProof(current, requireRegistration);
    function assertCurrent() {
      configuration.check();
      inspectionPorts.check();
      proof.assertCurrent();
      const age = clock.call(ports) - Date.parse(proof.data.observedAt);
      configuration.check();
      inspectionPorts.check();
      proof.check();
      const state = enrollment.readPolicySnapshot();
      requireRegistration(state.status === "enrolled", "enrollment is unavailable");
      const target = state.grant.manifest.targets.find(
        (item) => item.target === "container-daemon",
      );
      requireRegistration(target, "enrolled Dev target is unavailable");
      const descriptor = readEnrollmentNativeIdentity(config.stateDir, target.identitySha256);
      const data = proof.data;
      // Native custody and clock callbacks have finished. These final data and
      // enrollment checks cannot be bypassed by replacing their original callbacks.
      requireRegistration(
        Number.isFinite(age) && age >= 0 && age < FRESHNESS_MS,
        "evidence expired",
      );
      requireRegistration(
        data.identitySha256 === target.identitySha256 &&
          isDeepStrictEqual(data.descriptor, descriptor) &&
          descriptor.environment === "container" &&
          descriptor.target === "container-daemon" &&
          descriptor.installationId === config.public.installationId &&
          descriptor.stateDirectory === config.stateDir &&
          data.custodyStateDirectory === config.stateDir &&
          data.serverId ===
            config.public.environments.find((item) => item.kind === "container")?.serverId,
        "native observation differs from the configured enrolled target",
      );
    }
    assertCurrent();
    return { ...proof.data, assertCurrent };
  }
  /** This prerequisite grants no standing, interruption or Factory authority. */
  function assertRegistrationReadiness(target: RestartJob["target"]): void {
    if (target !== "container-daemon") return;
    if (!registrationRequired && config.container.persistentRegistration === undefined) return;
    try {
      requireRegistration(registrationRequired, "configuration changed");
      configuration.check();
      const current = native.get(target);
      requireRegistration(
        current && current === registrationObservation,
        "independent current registration is unavailable",
      );
      const result: unknown = current.assertCurrent();
      requireRegistration(result === undefined, "custody assertion must be synchronous");
    } catch (error) {
      native.delete(target);
      registrationObservation = null;
      throw error;
    }
  }
  function registrationReadiness(): { available: boolean } {
    try {
      assertRegistrationReadiness("container-daemon");
      return { available: true };
    } catch {
      return { available: false };
    }
  }
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
      assertRegistrationReadiness,
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
      registrationObservation = null;
      sources.clear();
      return;
    }
    await Promise.all(
      (["host", "container-daemon"] as const).map(async (target) => {
        native.delete(target);
        if (target === "container-daemon") registrationObservation = null;
        const binding = state.grant.manifest.targets.find((item) => item.target === target);
        if (!binding) return;
        try {
          const expected = readEnrollmentNativeIdentity(config.stateDir, binding.identitySha256);
          if (target === "container-daemon" && registrationRequired) {
            configuration.check();
            inspectionPorts.check();
          }
          const inspect =
            target === "container-daemon" && registrationRequired
              ? inspectionPorts.snapshot.inspect
              : ports.inspect;
          const current = await inspect.call(ports, config, expected);
          if (current.identitySha256 !== binding.identitySha256)
            throw new Error("Observed daemon identity differs from enrollment");
          const retained =
            target === "container-daemon" && registrationRequired
              ? retainRegistration(current)
              : current;
          native.set(target, retained);
          if (target === "container-daemon" && registrationRequired)
            registrationObservation = retained;
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
  async function observeInterruption(job: RestartJob): Promise<string> {
    const intent = job.standingInterruption;
    if (job.status !== "running" || !intent)
      throw new Error("Interruption observation requires its retained running reservation");
    const descriptor = readEnrollmentNativeIdentity(config.stateDir, intent.native.identitySha256);
    if (descriptor.target !== job.target)
      throw new Error("Interruption descriptor belongs to a different target");
    const current = await ports.inspect(config, descriptor);
    assertFreshOutcome(current);
    assertReplacement(job, current);
    const updater = updates[job.target];
    let assertSource = () => {};
    if (job.update) {
      if (!updater || !intent.candidate)
        throw new Error("Source outcome verification is unavailable");
      assertSource = await updater.verifyInstalledInterruption({
        job,
        expected: intent.candidate,
        writableMountRoots: current.writableMountRoots,
      });
    }
    if (!current.verifyPreviousWorkerExited)
      throw new Error("Independent previous worker exit verification is unavailable");
    await current.verifyPreviousWorkerExited(intent.native.worker);
    const final = await ports.inspect(config, descriptor);
    assertFreshOutcome(final);
    assertReplacement(job, final);
    if (
      instance(current) !== instance(final) ||
      current.workerInstanceId !== final.workerInstanceId
    )
      throw new Error("Replacement changed during interruption observation");
    current.assertCurrent();
    final.assertCurrent();
    assertSource();
    native.set(job.target, final);
    return "Reviewed runtime, replacement worker and previous worker exit independently verified.";
  }
  function assertFreshOutcome(current: EnrollmentDaemonObservation): void {
    const age = ports.now() - Date.parse(current.observedAt);
    if (!Number.isFinite(age) || age < 0 || age >= FRESHNESS_MS)
      throw new Error("Native interruption outcome observation is stale or invalid");
  }
  async function verifySelection(job: RestartJob, executor: RestartExecutor): Promise<void> {
    assertRegistrationReadiness(job.target);
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
    registrationReadiness,
    assertRegistrationReadiness,
    refresh,
    initialActivationInstance,
    prepareInterruption,
    observeInterruption,
    verifySelection,
    observations,
  };
}

function assertReplacement(job: RestartJob, current: EnrollmentDaemonObservation): void {
  const intent = job.standingInterruption!;
  const expected = intent.candidate ?? {
    sourceCommit: intent.native.sourceCommit,
    release: intent.native.selectedRelease,
  };
  if (
    current.identitySha256 !== intent.native.identitySha256 ||
    current.serverId !== intent.native.serverId ||
    current.sourceCommit !== expected.sourceCommit ||
    current.selectedRelease !== expected.release ||
    !current.workerInstanceId ||
    current.workerInstanceId === intent.held.workerInstanceId ||
    current.restartDrainId !== null ||
    Date.parse(current.observedAt) < Date.parse(intent.reservedAt)
  )
    throw new Error("Native outcome does not prove the exact reviewed replacement");
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
