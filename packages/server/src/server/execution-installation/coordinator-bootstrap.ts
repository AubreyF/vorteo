import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { compare } from "bcryptjs";
import { z } from "zod";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import {
  CoordinatorBootstrapPlanSchema,
  CoordinatorBootstrapPreparationSchema,
  CoordinatorBootstrapDecisionSchema,
  CoordinatorBootstrapRequestSchema,
  CoordinatorAutomaticAuthoritySchema,
  CoordinatorAutomaticCheckSchema,
  type CoordinatorAutomaticAuthority,
  type CoordinatorAutomaticStatus,
  type CoordinatorBootstrapPlan,
  type CoordinatorBootstrapRequest,
  type CoordinatorBootstrapStage,
} from "@getpaseo/protocol/coordinator-bootstrap";

export interface BootstrapRequestJournal {
  read(): CoordinatorBootstrapRequest[];
  /** Publish an exact protected claim only after independent recovery is armed. */
  promote?(request: CoordinatorBootstrapRequest): void;
  /** Atomically compare against expected and persist next, or refuse the edit. */
  replace(expected: CoordinatorBootstrapRequest[], next: CoordinatorBootstrapRequest[]): void;
}

const BindingSchema = z.strictObject({
  environment: z.literal("host"),
  installationId: z.string().uuid(),
  service: z.string().regex(/^gui\/\d+\/local\.vorteo\.[a-zA-Z0-9.-]+\.installation$/),
  ownerPasswordHash: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/),
});
export type BootstrapHostBinding = z.infer<typeof BindingSchema>;

export class BootstrapRequestConflict extends Error {}
export class BootstrapAuthenticationRequired extends Error {}
/** Positive busy evidence only; parsing or identity failures must never use this type. */
export class BootstrapCoordinatorBusy extends BootstrapRequestConflict {}

export type BootstrapReconciliationLedger = Pick<
  CoordinatorBootstrapRequests,
  "list" | "revokeAutomatic" | "reserveAutomaticReconciliation" | "finishAutomaticReconciliation"
>;

export function coordinatorAutomaticStatus(
  request: CoordinatorBootstrapRequest,
  now: number,
): CoordinatorAutomaticStatus | undefined {
  if (!request.automaticSubmission) return undefined;
  const ownerApproved = request.status === "approved" && !request.automaticApproval;
  const authorization = ownerApproved ? "owner" : "host-policy";
  const common = { authorization, observedAt: new Date(now).toISOString() } as const;
  if (request.execution) return { ...common, state: "execution" };
  if (request.status === "canceled") return { ...common, state: "canceled" };
  if (ownerApproved) return { ...common, state: "owner-approved" };
  if (request.automaticDispatch) return { ...common, state: "launch-unconfirmed" };
  const dispatchAfter = request.automaticApproval?.dispatchAfter;
  if (dispatchAfter && now < Date.parse(dispatchAfter))
    return { ...common, state: "cancellation-window", dispatchAfter };
  const phase = request.status === "pending" ? "approval" : "dispatch";
  const check = request.automaticCheck;
  if (check?.phase === phase) {
    const running = check.outcome === "running" && now < Date.parse(check.retryAfter);
    if (running)
      return {
        ...common,
        state: "checking",
        attempt: check.attempt,
        nextCheckAt: check.retryAfter,
      };
    if (check.attempt >= 3) return { ...common, state: "review-required", attempt: check.attempt };
    return {
      ...common,
      state: "retry-wait",
      attempt: check.attempt,
      nextCheckAt: check.retryAfter,
    };
  }
  const state = request.status === "approved" ? "dispatch-ready" : "waiting";
  return { ...common, state };
}

/** Call only after verifying the exact coordinator is frozen and collecting its
 * children. A quiet journal from a running coordinator is not a dispatch fence. */
export function assertFrozenCoordinatorIdle(journal: unknown, childPids: unknown): void {
  const jobs = parseLifecycleJournal(journal);
  const children = z.array(z.number().int().positive()).parse(childPids);
  if (children.length > 0)
    throw new BootstrapCoordinatorBusy("Coordinator preparation children are still running");
  assertCoordinatorLifecycleIdle(jobs);
}

/** Journal admission also uses this check under the shared writer lock.
 * It excludes recorded work, but cannot establish native process quiescence. */
export function assertCoordinatorLifecycleIdle(journal: unknown): void {
  const work = coordinatorLifecycleWork(journal);
  if (work.some((job) => job.target === "native-helper" || job.target === "preview-monitor"))
    throw new BootstrapCoordinatorBusy("Coordinator has unresolved helper installation work");
  if (work.length > 0)
    throw new BootstrapCoordinatorBusy("Coordinator has unresolved installation work");
}

export function coordinatorLifecycleWork(journal: unknown) {
  return parseLifecycleJournal(journal).filter((job) => {
    if (job.target === "native-helper" || job.target === "preview-monitor") {
      return (
        ["approved", "running"].includes(job.status) ||
        (job.stage === "preparing" && job.status === "pending") ||
        job.stage === "recovery_required"
      );
    }
    const active = job.status === "approved" || job.status === "running";
    const held = job.finishCurrentTurns === true && job.holdReleased !== true;
    const preparing = job.sourceBatch?.status === "preparing";
    return active || held || preparing;
  });
}

const dispatchIdentity = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const progressIdentity = dispatchIdentity.extend({
  generation: z.string().uuid(),
});
const transitions: Record<CoordinatorBootstrapStage, readonly CoordinatorBootstrapStage[]> = {
  claimed: ["freeze_pending", "recovery_required"],
  freeze_pending: ["frozen", "resume_pending", "recovery_required"],
  frozen: ["unload_pending", "resume_pending", "recovery_required"],
  unload_pending: ["unloaded", "recovery_required"],
  unloaded: ["selection_pending", "recovery_required"],
  selection_pending: ["selected", "recovery_required"],
  selected: ["start_pending", "recovery_required"],
  start_pending: ["started", "recovery_required"],
  started: ["verifying", "recovery_required"],
  verifying: ["succeeded", "recovery_required"],
  resume_pending: ["resumed", "recovery_required"],
  resumed: [],
  succeeded: [],
  recovery_required: ["rollback_pending"],
  rollback_pending: ["rolled_back", "recovery_required"],
  rolled_back: [],
};

export function isCompletedBootstrap(request: CoordinatorBootstrapRequest): boolean {
  return (
    request.status === "approved" &&
    request.execution !== undefined &&
    ["succeeded", "resumed", "rolled_back"].includes(request.execution.stage)
  );
}

/** Preserve completed audit chains without treating them as live admission owners. */
export function openBootstrapRequests(
  records: CoordinatorBootstrapRequest[],
  recovered: CoordinatorBootstrapRequest | null = null,
): CoordinatorBootstrapRequest[] {
  const superseded = new Set<string>();
  const retainClosedChain = (first: CoordinatorBootstrapRequest | null) => {
    const visited = new Set<string>();
    for (let old = first; old; old = assertRecoveredBootstrapBase(old.plan, records)) {
      if (visited.has(old.id))
        throw new BootstrapRequestConflict("Cyclic bootstrap recovery history");
      visited.add(old.id);
      superseded.add(old.id);
    }
  };
  retainClosedChain(recovered);
  // Completion closes admission ownership, not the audit record. A verified
  // recovery also closes its exact failed ancestry; unrelated failures remain open.
  for (const record of records) {
    if (isCompletedBootstrap(record)) retainClosedChain(record);
  }
  return records.filter((item) => item.status !== "canceled" && !superseded.has(item.id));
}

/** A fresh review can follow verified restoration without rewriting failed history. */
export function assertRecoveredBootstrapBase(
  plan: CoordinatorBootstrapPlan,
  records: CoordinatorBootstrapRequest[],
): CoordinatorBootstrapRequest | null {
  const reference = plan.recoveredFrom;
  if (!reference) return null;
  const previous = records.find((request) => request.id === reference.id);
  const sameFailure =
    previous?.revision === reference.revision &&
    previous.planSha256 === reference.planSha256 &&
    previous.execution?.generation === reference.generation &&
    ["recovery_required", "rolled_back", "resumed"].includes(previous.execution.stage);
  if (!previous || !sameFailure)
    throw new BootstrapRequestConflict("Recovered coordinator history changed");
  const old =
    previous.execution?.stage === "rolled_back"
      ? bootstrapRecoveryRelease(previous.plan)
      : previous.plan.previous;
  const current = plan.previous;
  const { configuration: oldConfiguration, launcher: oldLauncher, ...oldExecutable } = old;
  const {
    configuration: currentConfiguration,
    launcher: currentLauncher,
    ...currentExecutable
  } = current;
  if (
    !isDeepStrictEqual(oldExecutable, currentExecutable) ||
    oldConfiguration.sha256 !== currentConfiguration.sha256 ||
    oldLauncher.sha256 !== currentLauncher.sha256 ||
    previous.plan.service !== plan.service ||
    previous.plan.installationId !== plan.installationId
  )
    throw new BootstrapRequestConflict("Fresh review must retain the verified restored release");
  return previous;
}

export function bootstrapRecoveryRelease(plan: CoordinatorBootstrapPlan) {
  if (plan.automaticRecovery === "restore-compatible") {
    if (!plan.compatibleRecovery)
      throw new BootstrapRequestConflict("Compatible rollback requires an exact recovery release");
    return plan.compatibleRecovery;
  }
  if (plan.compatibleRecovery)
    throw new BootstrapRequestConflict("Recovery release requires compatible rollback approval");
  return plan.previous;
}

export function coordinatorPlanDigest(value: unknown): string {
  // Zod emits the declared key order, independent of a caller's object key order.
  const plan = CoordinatorBootstrapPlanSchema.parse(value);
  bootstrapRecoveryRelease(plan);
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function assertAutomaticCoordinatorPlan(plan: CoordinatorBootstrapPlan): void {
  if (
    !plan.bootRecovery ||
    plan.automaticRecovery !== "restore-compatible" ||
    !plan.compatibleRecovery
  )
    throw new BootstrapRequestConflict(
      "Automatic coordinator maintenance requires independent compatible recovery",
    );
  if (
    plan.candidate.configuration.sha256 !== plan.previous.configuration.sha256 ||
    plan.compatibleRecovery.configuration.sha256 !== plan.previous.configuration.sha256 ||
    plan.recoveredFrom ||
    plan.sourceUpdateTooling ||
    plan.nativeHelperConfiguration !== undefined ||
    plan.previewMonitorConfiguration !== undefined ||
    plan.factoryRuntimeAdoptionConfiguration !== undefined
  )
    throw new BootstrapRequestConflict(
      "Coordinator configuration, recovery successors and other service changes require exact owner review",
    );
}

/** Durable decisions and dispatch stages only. This boundary performs no service operations. */
export class CoordinatorBootstrapRequests {
  private readonly approvalChecks = new Map<string, Promise<void>>();

  private verifyApproval(request: CoordinatorBootstrapRequest): Promise<void> {
    const key = `${request.id}:${request.revision}:${request.planSha256}`;
    const existing = this.approvalChecks.get(key);
    if (existing) return existing;
    // Share only an in-flight check. Never cache completed artifact verification.
    // Each caller still authenticates, rechecks its binding and commits by CAS.
    const check = Promise.resolve()
      .then(() => this.verifyPreparedBytes(request.plan))
      .finally(() => {
        if (this.approvalChecks.get(key) === check) this.approvalChecks.delete(key);
      });
    this.approvalChecks.set(key, check);
    return check;
  }

  constructor(
    private readonly journal: BootstrapRequestJournal,
    private readonly binding: () => unknown,
    private readonly verifyPreparedBytes: (plan: CoordinatorBootstrapPlan) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly automaticAuthority: () => CoordinatorAutomaticAuthority | null = () => null,
  ) {
    BindingSchema.parse(binding());
  }

  list(): CoordinatorBootstrapRequest[] {
    BindingSchema.parse(this.binding());
    const records = this.read();
    for (const record of records) this.readBinding(record.plan);
    return records;
  }

  async prepare(value: unknown): Promise<CoordinatorBootstrapRequest> {
    return this.prepareRequest(value);
  }

  private async prepareRequest(
    value: unknown,
    authority?: CoordinatorAutomaticAuthority,
  ): Promise<CoordinatorBootstrapRequest> {
    const input = CoordinatorBootstrapPreparationSchema.parse(value);
    if (input.plan.bootRecovery && input.plan.bootRecovery.requestId !== input.id)
      throw new BootstrapRequestConflict("Boot recovery must bind the exact maintenance request");
    const binding = this.readBinding(input.plan);
    const expected = this.read();
    const digest = coordinatorPlanDigest(input.plan);
    const existing = expected.find((item) => item.id === input.id);
    if (existing) {
      if (existing.planSha256 !== digest || existing.reason !== input.reason)
        throw new BootstrapRequestConflict("This request ID already names different prepared work");
      if (
        authority &&
        (!existing.automaticSubmission ||
          !this.matchesAutomaticAuthority(existing.automaticSubmission, authority))
      )
        throw new BootstrapRequestConflict(
          "Existing coordinator request cannot acquire automatic authority",
        );
      return existing;
    }
    const recovered = assertRecoveredBootstrapBase(input.plan, expected);
    if (openBootstrapRequests(expected, recovered).length > 0)
      throw new BootstrapRequestConflict("A coordinator bootstrap request is already open");
    await this.verifyPreparedBytes(input.plan);
    this.requireSameBinding(binding, input.plan);
    if (authority) this.requireSubmissionAuthority(authority);
    const request: CoordinatorBootstrapRequest = {
      ...(authority
        ? { automaticSubmission: { ...authority, submittedAt: new Date(this.now()).toISOString() } }
        : {}),
      id: input.id,
      revision: randomUUID(),
      requestedBy: "host-agent",
      reason: input.reason,
      createdAt: new Date(this.now()).toISOString(),
      plan: input.plan,
      planSha256: digest,
      status: "pending",
    };
    this.journal.replace(expected, [...expected, request]);
    return structuredClone(request);
  }

  /** Native admission calls this only after verifying exact scoped submission.
   * Provenance is inserted with preparation, never attached to an old request. */
  async prepareAutomatic(
    value: unknown,
    authority: CoordinatorAutomaticAuthority,
  ): Promise<CoordinatorBootstrapRequest> {
    this.requireSubmissionAuthority(authority);
    return this.prepareRequest(value, authority);
  }

  private requireSubmissionAuthority(authority: CoordinatorAutomaticAuthority): void {
    CoordinatorAutomaticAuthoritySchema.parse(authority);
    const current = CoordinatorAutomaticAuthoritySchema.nullable().parse(this.automaticAuthority());
    if (
      !this.matchesAutomaticAuthority(authority, current) ||
      this.now() < Date.parse(authority.policyActivatedAt)
    )
      throw new BootstrapAuthenticationRequired(
        "Current scoped Host coordinator permission required",
      );
  }

  private matchesAutomaticAuthority(
    recorded: CoordinatorAutomaticAuthority,
    current: CoordinatorAutomaticAuthority | null,
  ): boolean {
    return (
      current !== null &&
      recorded.credentialBinding === current.credentialBinding &&
      recorded.policyActivatedAt === current.policyActivatedAt
    );
  }

  private requireAutomaticAuthority(
    request: CoordinatorBootstrapRequest,
  ): CoordinatorAutomaticAuthority {
    const authority = CoordinatorAutomaticAuthoritySchema.nullable().parse(
      this.automaticAuthority(),
    );
    if (
      !authority ||
      !request.automaticSubmission ||
      !this.matchesAutomaticAuthority(request.automaticSubmission, authority)
    )
      throw new BootstrapAuthenticationRequired(
        "Coordinator automatic authority is missing or revoked",
      );
    return authority;
  }

  /** No service effects. A separate managed dispatcher observes the cancellation
   * interval and claims the exact durable approval through claimDispatch. */
  async approveAutomatic(value: unknown): Promise<CoordinatorBootstrapRequest> {
    const input = dispatchIdentity.parse(value);
    const expected = this.read();
    const request = expected.find((item) => item.id === input.id);
    if (
      !request ||
      request.revision !== input.revision ||
      request.planSha256 !== input.planSha256 ||
      request.status !== "pending" ||
      request.execution
    )
      throw new BootstrapRequestConflict("Exact pending coordinator request required");
    const binding = this.readBinding(request.plan);
    const authority = this.requireAutomaticAuthority(request);
    assertAutomaticCoordinatorPlan(request.plan);
    await this.verifyApproval(request);
    this.requireSameBinding(binding, request.plan);
    if (!isDeepStrictEqual(authority, this.requireAutomaticAuthority(request)))
      throw new BootstrapAuthenticationRequired("Coordinator authority changed during validation");
    const revision = randomUUID();
    const now = this.now();
    const next: CoordinatorBootstrapRequest = {
      ...request,
      revision,
      status: "approved",
      decisionAt: new Date(now).toISOString(),
      automaticApproval: {
        ...authority,
        requestRevision: revision,
        dispatchAfter: new Date(now + 30_000).toISOString(),
      },
    };
    this.journal.replace(
      expected,
      expected.map((item) => (item.id === next.id ? next : item)),
    );
    return structuredClone(next);
  }

  reserveAutomaticReconciliation(value: unknown): CoordinatorBootstrapRequest | null {
    const input = dispatchIdentity.parse(value);
    const expected = this.read();
    const request = expected.find((item) => item.id === input.id);
    if (!request || request.revision !== input.revision || request.planSha256 !== input.planSha256)
      throw new BootstrapRequestConflict("Coordinator request changed before reconciliation");
    if (request.status === "canceled" || request.execution || request.automaticDispatch)
      return null;
    this.readBinding(request.plan);
    this.requireAutomaticAuthority(request);
    if (request.status === "approved") {
      if (!request.automaticApproval) return null;
      if (this.now() < Date.parse(request.automaticApproval.dispatchAfter)) return null;
      this.requireEligibleAutomaticDispatch(request);
    }
    const phase = request.status === "pending" ? "approval" : "dispatch";
    const previous = request.automaticCheck?.phase === phase ? request.automaticCheck : undefined;
    if (previous && (previous.attempt >= 3 || this.now() < Date.parse(previous.retryAfter)))
      return null;
    const attempt = (previous?.attempt ?? 0) + 1;
    const revision = randomUUID();
    const next: CoordinatorBootstrapRequest = {
      ...request,
      revision,
      ...(request.automaticApproval
        ? { automaticApproval: { ...request.automaticApproval, requestRevision: revision } }
        : {}),
      automaticCheck: {
        phase,
        attempt,
        startedAt: new Date(this.now()).toISOString(),
        // Cover connection and RPC deadlines after a coordinator crash. A live
        // caller records the shorter backoff when its observation finishes.
        retryAfter: new Date(this.now() + 16 * 60_000).toISOString(),
        outcome: "running",
      },
    };
    this.journal.replace(
      expected,
      expected.map((item) => (item.id === next.id ? next : item)),
    );
    return structuredClone(next);
  }

  requireAutomaticReconciliation(request: CoordinatorBootstrapRequest): void {
    const phase = request.status === "pending" ? "approval" : "dispatch";
    const check = request.automaticCheck;
    if (
      !check ||
      check.phase !== phase ||
      check.outcome !== "running" ||
      this.now() >= Date.parse(check.retryAfter)
    )
      throw new BootstrapRequestConflict(
        "A current bounded coordinator reconciliation is required",
      );
  }

  finishAutomaticReconciliation(id: string, value: unknown): void {
    const check = CoordinatorAutomaticCheckSchema.parse(value);
    const expected = this.read();
    const request = expected.find((item) => item.id === id);
    const phase = request?.status === "pending" ? "approval" : "dispatch";
    if (
      !request ||
      request.status === "canceled" ||
      request.execution ||
      request.automaticDispatch ||
      phase !== check.phase ||
      !isDeepStrictEqual(request.automaticCheck, check)
    )
      return;
    this.readBinding(request.plan);
    const revision = randomUUID();
    const backoff = [5_000, 15_000, 45_000][check.attempt - 1]!;
    const next: CoordinatorBootstrapRequest = {
      ...request,
      revision,
      ...(request.automaticApproval
        ? { automaticApproval: { ...request.automaticApproval, requestRevision: revision } }
        : {}),
      automaticCheck: {
        ...check,
        outcome: "unconfirmed",
        retryAfter: new Date(this.now() + backoff).toISOString(),
      },
    };
    this.journal.replace(
      expected,
      expected.map((item) => (item.id === next.id ? next : item)),
    );
  }

  /** Reserve one native launch before spawning. A lost response never permits a
   * second launch; cancellation still wins until the executor's durable claim. */
  reserveAutomaticDispatch(value: unknown): CoordinatorBootstrapRequest {
    const input = dispatchIdentity.parse(value);
    const expected = this.read();
    const request = expected.find((item) => item.id === input.id);
    if (
      !request ||
      request.revision !== input.revision ||
      request.planSha256 !== input.planSha256 ||
      request.status !== "approved" ||
      request.execution ||
      request.automaticDispatch
    )
      throw new BootstrapRequestConflict(
        "Exact automatic approval has already changed or reserved dispatch",
      );
    this.readBinding(request.plan);
    this.requireEligibleAutomaticDispatch(request);
    const revision = randomUUID();
    const next: CoordinatorBootstrapRequest = {
      ...request,
      revision,
      automaticApproval: { ...request.automaticApproval!, requestRevision: revision },
      automaticDispatch: {
        approvedRevision: request.revision,
        requestedAt: new Date(this.now()).toISOString(),
      },
    };
    this.journal.replace(
      expected,
      expected.map((item) => (item.id === next.id ? next : item)),
    );
    return structuredClone(next);
  }

  private requireEligibleAutomaticDispatch(request: CoordinatorBootstrapRequest): void {
    const authority = this.requireAutomaticAuthority(request);
    if (
      !request.automaticApproval ||
      !this.matchesAutomaticAuthority(request.automaticApproval, authority) ||
      request.automaticApproval.requestRevision !== request.revision ||
      this.now() < Date.parse(request.automaticApproval.dispatchAfter)
    )
      throw new BootstrapRequestConflict(
        "Coordinator automatic dispatch is revoked or not yet eligible",
      );
  }

  /** Called by the preference writer before confirming revocation. CAS prevents
   * cancellation from overwriting a concurrently claimed native execution. */
  revokeAutomatic(): void {
    const expected = this.read();
    const authority = CoordinatorAutomaticAuthoritySchema.nullable().parse(
      this.automaticAuthority(),
    );
    let changed = false;
    const next = expected.map((request) => {
      const recorded =
        request.automaticApproval ??
        (request.status === "pending" ? request.automaticSubmission : undefined);
      if (
        !recorded ||
        request.execution ||
        request.status === "canceled" ||
        this.matchesAutomaticAuthority(recorded, authority)
      )
        return request;
      this.readBinding(request.plan);
      changed = true;
      return {
        ...request,
        revision: randomUUID(),
        status: "canceled" as const,
        decisionAt: new Date(this.now()).toISOString(),
      };
    });
    if (changed) this.journal.replace(expected, next);
  }

  async decide(value: unknown, ownerPassword: string): Promise<CoordinatorBootstrapRequest> {
    const input = CoordinatorBootstrapDecisionSchema.parse(value);
    const expected = this.read();
    const request = expected.find((item) => item.id === input.id);
    if (!request || request.revision !== input.revision || request.planSha256 !== input.planSha256)
      throw new BootstrapRequestConflict("Bootstrap request changed. Refresh its review.");
    if (request.execution)
      throw new BootstrapRequestConflict("Bootstrap dispatch has already claimed this request");
    if (
      request.status !== "pending" &&
      !(input.decision === "cancel" && request.status === "approved")
    )
      throw new BootstrapRequestConflict("Bootstrap request has already been decided");
    const binding = this.readBinding(request.plan);
    // The daemon's role label and scoped agent keys are not owner authentication.
    if (!ownerPassword || !(await compare(ownerPassword, binding.ownerPasswordHash)))
      throw new BootstrapAuthenticationRequired("Installation owner authentication required");
    if (input.decision === "approve") await this.verifyApproval(request);
    this.requireSameBinding(binding, request.plan);
    const { automaticApproval, ...manualRequest } = request;
    const next: CoordinatorBootstrapRequest = {
      ...manualRequest,
      ...(input.decision === "cancel" && automaticApproval ? { automaticApproval } : {}),
      revision: randomUUID(),
      status: input.decision === "approve" ? "approved" : "canceled",
      decisionAt: new Date(this.now()).toISOString(),
    };
    // Another decision or preparation may finish during authentication or byte checks.
    this.journal.replace(
      expected,
      expected.map((item) => (item.id === next.id ? next : item)),
    );
    return structuredClone(next);
  }

  /** Only the bounded Host executor calls this, never a browser or agent RPC. */
  async claimDispatch(value: unknown): Promise<CoordinatorBootstrapRequest> {
    const input = dispatchIdentity.parse(value);
    const expected = this.read();
    const request = expected.find((item) => item.id === input.id);
    if (
      !request ||
      request.revision !== input.revision ||
      request.planSha256 !== input.planSha256 ||
      request.status !== "approved" ||
      request.execution
    )
      throw new BootstrapRequestConflict("Exact undispatched bootstrap approval required");
    const binding = this.readBinding(request.plan);
    await this.verifyPreparedBytes(request.plan);
    this.requireSameBinding(binding, request.plan);
    if (request.automaticApproval) {
      this.requireEligibleAutomaticDispatch(request);
      if (!request.automaticDispatch)
        throw new BootstrapRequestConflict(
          "Automatic coordinator dispatch must reserve its native launch",
        );
    }
    const next: CoordinatorBootstrapRequest = {
      ...request,
      revision: randomUUID(),
      execution: {
        generation: randomUUID(),
        stage: "claimed",
        updatedAt: new Date(this.now()).toISOString(),
      },
    };
    this.journal.replace(
      expected,
      expected.map((item) => (item.id === next.id ? next : item)),
    );
    return structuredClone(next);
  }

  promoteDispatch(request: CoordinatorBootstrapRequest): void {
    if (request.plan.automaticRecovery !== "restore-compatible") return;
    if (!this.journal.promote)
      throw new BootstrapRequestConflict("Bootstrap journal cannot protect compatible recovery");
    this.journal.promote(request);
  }

  advanceDispatch(value: unknown, stage: CoordinatorBootstrapStage): CoordinatorBootstrapRequest {
    const input = progressIdentity.parse(value);
    const expected = this.read();
    const request = expected.find((item) => item.id === input.id);
    if (
      !request ||
      request.revision !== input.revision ||
      request.planSha256 !== input.planSha256 ||
      request.status !== "approved" ||
      request.execution?.generation !== input.generation
    )
      throw new BootstrapRequestConflict("Bootstrap dispatch ownership changed");
    // A native observer may recognize a rollback whose terminal write was lost.
    // This transition consumes no new attempt and grants no lifecycle effect.
    const observedRollback =
      stage === "rolled_back" &&
      request.execution.stage === "recovery_required" &&
      request.plan.automaticRecovery !== undefined &&
      request.execution.rollbackAttemptedAt !== undefined;
    if (!transitions[request.execution.stage].includes(stage) && !observedRollback)
      throw new BootstrapRequestConflict("Invalid bootstrap dispatch transition");
    if (
      stage === "rollback_pending" &&
      (!request.plan.automaticRecovery || request.execution.rollbackAttemptedAt)
    )
      throw new BootstrapRequestConflict("Automatic rollback requires unused exact plan approval");
    const updatedAt = new Date(this.now()).toISOString();
    const rollbackAttemptedAt =
      stage === "rollback_pending" ? updatedAt : request.execution.rollbackAttemptedAt;
    const next: CoordinatorBootstrapRequest = {
      ...request,
      revision: randomUUID(),
      execution: {
        ...request.execution,
        stage,
        updatedAt,
        ...(rollbackAttemptedAt ? { rollbackAttemptedAt } : {}),
      },
    };
    this.journal.replace(
      expected,
      expected.map((item) => (item.id === next.id ? next : item)),
    );
    return structuredClone(next);
  }

  private read(): CoordinatorBootstrapRequest[] {
    const records = z.array(CoordinatorBootstrapRequestSchema).parse(this.journal.read());
    if (new Set(records.map((item) => item.id)).size !== records.length)
      throw new BootstrapRequestConflict("Duplicate bootstrap request identity");
    for (const request of records) {
      if (request.execution && request.status !== "approved")
        throw new BootstrapRequestConflict("Bootstrap dispatch has no owner approval");
      if (coordinatorPlanDigest(request.plan) !== request.planSha256)
        throw new BootstrapRequestConflict("Stored bootstrap plan failed its digest check");
    }
    return records;
  }

  private readBinding(plan: CoordinatorBootstrapPlan): BootstrapHostBinding {
    const binding = BindingSchema.parse(this.binding());
    if (binding.installationId !== plan.installationId || binding.service !== plan.service)
      throw new BootstrapRequestConflict("Prepared plan does not match this Host installation");
    return binding;
  }

  private requireSameBinding(expected: BootstrapHostBinding, plan: CoordinatorBootstrapPlan): void {
    const current = this.readBinding(plan);
    if (current.ownerPasswordHash !== expected.ownerPasswordHash)
      throw new BootstrapRequestConflict(
        "Installation owner authentication changed. Review again.",
      );
  }
}
