import { compare } from "bcryptjs";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import {
  BootstrapClaimedRecoveryPlanSchema,
  BootstrapClaimedRecoveryRequestSchema,
  type BootstrapClaimedRecoveryPlan,
  type BootstrapClaimedRecoveryRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
  coordinatorPlanDigest,
  type BootstrapHostBinding,
} from "./coordinator-bootstrap.js";

/** Structural admission only. The protected Host must independently verify
 * retained bytes, native identities, unpromoted state and selection each time. */
export function validateClaimedRecoveryPlan(value: unknown): BootstrapClaimedRecoveryPlan {
  const plan = BootstrapClaimedRecoveryPlanSchema.parse(value);
  const original = plan.original;
  if (
    original.status !== "approved" ||
    !original.decisionAt ||
    original.execution?.stage !== "claimed" ||
    original.execution.rollbackAttemptedAt !== undefined ||
    original.plan.automaticRecovery !== "restore-compatible" ||
    !original.plan.compatibleRecovery ||
    original.planSha256 !== coordinatorPlanDigest(original.plan) ||
    plan.dispatchApprovalRevision === original.revision
  )
    throw new BootstrapRequestConflict("Exact approved compatible claim required");
  validateClaimedProcessBinding(plan);
  return plan;
}

function validateClaimedProcessBinding(plan: BootstrapClaimedRecoveryPlan): void {
  const original = plan.original;
  const executor = plan.executor.identity;
  const host = plan.hostProcess;
  const coordinator = plan.coordinatorProcess;
  const expected = original.plan.expectedProcess;
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
  if (
    new Set([executor.pid, host.pid, coordinator.pid]).size !== 3 ||
    !isDeepStrictEqual(
      { parentPid: executor.parentPid, uid: executor.uid, bootId: executor.bootId },
      { parentPid: host.pid, uid: host.uid, bootId: host.bootId },
    ) ||
    executor.uid !== plan.executor.auditToken[1] ||
    executor.pid !== plan.executor.auditToken[5] ||
    !isDeepStrictEqual(
      {
        pid: coordinator.pid,
        bootId: coordinator.bootId,
        startIdentity: coordinator.startIdentity,
        argumentsSha256: coordinator.argumentsSha256,
      },
      expected,
    ) ||
    coordinator.executable !== original.plan.previous.node.path ||
    coordinator.uid !== executor.uid ||
    coordinator.bootId !== executor.bootId ||
    !isDeepStrictEqual(plan.runner, original.plan.candidate) ||
    plan.executorEntrypoint.path !==
      path.join(
        plan.runner.directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
      ) ||
    executor.executable !== plan.runner.node.path ||
    executor.argumentsSha256 !== argumentsSha256 ||
    plan.selectedLauncher.sha256 !== original.plan.previous.launcher.sha256 ||
    plan.selectedConfiguration.sha256 !== original.plan.previous.configuration.sha256 ||
    plan.executionLock.path !==
      path.join(original.plan.state.directory, "coordinator-bootstrap-execution.lock")
  )
    throw new BootstrapRequestConflict("Claimed recovery native binding changed");
}

export function claimedRecoveryPlanDigest(plan: BootstrapClaimedRecoveryPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(BootstrapClaimedRecoveryPlanSchema.parse(plan)))
    .digest("hex");
}

export interface ClaimedRecoveryReviewJournal {
  readReviews(): BootstrapClaimedRecoveryRequest[];
  replaceReviews(
    expected: BootstrapClaimedRecoveryRequest[],
    next: BootstrapClaimedRecoveryRequest[],
  ): void;
}
const IdentitySchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type Stage = NonNullable<BootstrapClaimedRecoveryRequest["execution"]>["stage"];

/** This service never dispatches effects. Cancellation and claim compete through
 * the journal CAS; slow native verification cannot resurrect a canceled review. */
export class ClaimedRecoveryReviews {
  constructor(
    private readonly journal: ClaimedRecoveryReviewJournal,
    private readonly readBinding: () => BootstrapHostBinding,
    private readonly verify: (plan: BootstrapClaimedRecoveryPlan) => Promise<void>,
  ) {}

  list(): BootstrapClaimedRecoveryRequest[] {
    const records = z
      .array(BootstrapClaimedRecoveryRequestSchema)
      .parse(this.journal.readReviews());
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new BootstrapRequestConflict("Duplicate claimed recovery identity");
    for (const record of records) {
      validateClaimedRecoveryPlan(record.plan);
      if (
        record.planSha256 !== claimedRecoveryPlanDigest(record.plan) ||
        record.id === record.plan.original.id
      )
        throw new BootstrapRequestConflict("Claimed recovery plan binding changed");
      if (
        (record.status === "approved" && !record.decisionAt) ||
        (record.execution && record.status !== "approved")
      )
        throw new BootstrapRequestConflict("Claimed recovery approval history changed");
    }
    return records;
  }

  private binding(plan: BootstrapClaimedRecoveryPlan): BootstrapHostBinding {
    const binding = structuredClone(this.readBinding());
    if (
      binding.environment !== "host" ||
      binding.installationId !== plan.original.plan.installationId ||
      binding.service !== plan.original.plan.service
    )
      throw new BootstrapRequestConflict("Claimed recovery installation changed");
    return binding;
  }

  async prepare(value: unknown): Promise<BootstrapClaimedRecoveryRequest> {
    const input = z
      .strictObject({
        id: z.string().uuid(),
        reason: z.string().min(1).max(4000),
        plan: BootstrapClaimedRecoveryPlanSchema,
      })
      .parse(value);
    const plan = validateClaimedRecoveryPlan(input.plan);
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
      throw new BootstrapRequestConflict("Claimed recovery already open");
    const binding = this.binding(plan);
    await this.verify(plan);
    if (!isDeepStrictEqual(binding, this.binding(plan)))
      throw new BootstrapRequestConflict("Claimed recovery installation changed");
    const pending: BootstrapClaimedRecoveryRequest = {
      id: input.id,
      revision: randomUUID(),
      requestedBy: "host-agent",
      reason: input.reason,
      createdAt: new Date().toISOString(),
      plan,
      planSha256: claimedRecoveryPlanDigest(plan),
      status: "pending",
    };
    this.journal.replaceReviews(expected, [...expected, pending]);
    return structuredClone(pending);
  }

  async decide(
    value: unknown,
    ownerPassword: string,
    reviewAcknowledged: boolean,
  ): Promise<BootstrapClaimedRecoveryRequest> {
    const input = IdentitySchema.extend({ decision: z.enum(["approve", "cancel"]) }).parse(value);
    if (input.decision === "approve" && reviewAcknowledged !== true)
      throw new BootstrapRequestConflict("Reload to review exact claimed recovery before approval");
    const expected = this.list();
    const current = expected.find((record) => record.id === input.id);
    if (
      !current ||
      current.revision !== input.revision ||
      current.planSha256 !== input.planSha256 ||
      current.execution ||
      (current.status !== "pending" &&
        !(current.status === "approved" && input.decision === "cancel"))
    )
      throw new BootstrapRequestConflict("Claimed recovery review changed or dispatch claimed");
    const binding = this.binding(current.plan);
    if (!ownerPassword || !(await compare(ownerPassword, binding.ownerPasswordHash)))
      throw new BootstrapAuthenticationRequired("Installation owner authentication required");
    if (input.decision === "approve") await this.verify(current.plan);
    if (!isDeepStrictEqual(binding, this.binding(current.plan)))
      throw new BootstrapRequestConflict("Claimed recovery installation changed");
    const next: BootstrapClaimedRecoveryRequest = {
      ...current,
      revision: randomUUID(),
      status: input.decision === "approve" ? "approved" : "canceled",
      decisionAt: new Date().toISOString(),
    };
    this.journal.replaceReviews(
      expected,
      expected.map((record) => (record.id === current.id ? next : record)),
    );
    return structuredClone(next);
  }

  async claim(value: unknown): Promise<BootstrapClaimedRecoveryRequest> {
    const input = IdentitySchema.parse(value);
    const expected = this.list();
    const current = expected.find((record) => record.id === input.id);
    if (
      !current ||
      current.revision !== input.revision ||
      current.planSha256 !== input.planSha256 ||
      current.status !== "approved" ||
      current.execution
    )
      throw new BootstrapRequestConflict("Exact undispatched claimed recovery approval required");
    const binding = this.binding(current.plan);
    await this.verify(current.plan);
    if (!isDeepStrictEqual(binding, this.binding(current.plan)))
      throw new BootstrapRequestConflict("Claimed recovery installation changed");
    const next: BootstrapClaimedRecoveryRequest = {
      ...current,
      revision: randomUUID(),
      execution: {
        generation: randomUUID(),
        stage: "claimed",
        updatedAt: new Date().toISOString(),
      },
    };
    this.journal.replaceReviews(
      expected,
      expected.map((record) => (record.id === current.id ? next : record)),
    );
    return structuredClone(next);
  }

  advance(
    expectedRequest: BootstrapClaimedRecoveryRequest,
    stage: Stage,
  ): BootstrapClaimedRecoveryRequest {
    const expected = this.list();
    const current = expected.find((record) => record.id === expectedRequest.id);
    if (
      !current ||
      !isDeepStrictEqual(current, expectedRequest) ||
      current.status !== "approved" ||
      !current.execution
    )
      throw new BootstrapRequestConflict("Claimed recovery execution ownership changed");
    const transitions: Record<Stage, readonly Stage[]> = {
      claimed: ["claim_fenced", "recovery_required"],
      claim_fenced: ["effect_pending", "verifying", "recovery_required"],
      effect_pending: ["verifying", "recovery_required"],
      verifying: ["succeeded", "recovery_required"],
      recovery_required: ["verifying"],
      succeeded: [],
      aborted_before_effects: [],
    };
    if (!transitions[current.execution.stage].includes(stage))
      throw new BootstrapRequestConflict("Invalid claimed recovery transition");
    const next: BootstrapClaimedRecoveryRequest = {
      ...current,
      revision: randomUUID(),
      execution: { ...current.execution, stage, updatedAt: new Date().toISOString() },
    };
    this.journal.replaceReviews(
      expected,
      expected.map((record) => (record.id === current.id ? next : record)),
    );
    return structuredClone(next);
  }
}
