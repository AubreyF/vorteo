import { createHash, randomUUID } from "node:crypto";
import { compare } from "bcryptjs";
import { z } from "zod";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import {
  CoordinatorBootstrapPlanSchema,
  CoordinatorBootstrapPreparationSchema,
  CoordinatorBootstrapDecisionSchema,
  CoordinatorBootstrapRequestSchema,
  type CoordinatorBootstrapPlan,
  type CoordinatorBootstrapRequest,
  type CoordinatorBootstrapStage,
} from "@getpaseo/protocol/coordinator-bootstrap";

export interface BootstrapRequestJournal {
  read(): CoordinatorBootstrapRequest[];
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

/** Call only after verifying the exact coordinator is frozen and collecting its
 * children. A quiet journal from a running coordinator is not a dispatch fence. */
export function assertFrozenCoordinatorIdle(journal: unknown, childPids: unknown): void {
  const jobs = parseLifecycleJournal(journal);
  const children = z.array(z.number().int().positive()).parse(childPids);
  if (children.length > 0)
    throw new BootstrapRequestConflict("Coordinator preparation children are still running");
  for (const job of jobs) {
    if (job.target === "native-helper") {
      if (
        ["approved", "running"].includes(job.status) ||
        (job.stage === "preparing" && job.status === "pending") ||
        job.stage === "recovery_required"
      )
        throw new BootstrapRequestConflict("Coordinator has unresolved helper installation work");
      continue;
    }
    const active = job.status === "approved" || job.status === "running";
    const held = job.finishCurrentTurns === true && job.holdReleased !== true;
    const preparing = job.sourceBatch?.status === "preparing";
    if (active || held || preparing)
      throw new BootstrapRequestConflict("Coordinator has unresolved installation work");
  }
}

const dispatchIdentity = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const progressIdentity = dispatchIdentity.extend({ generation: z.string().uuid() });
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
  recovery_required: [],
};

export function coordinatorPlanDigest(value: unknown): string {
  // Zod emits the declared key order, independent of a caller's object key order.
  const plan = CoordinatorBootstrapPlanSchema.parse(value);
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

/** Durable decisions and dispatch stages only. This boundary performs no service operations. */
export class CoordinatorBootstrapRequests {
  constructor(
    private readonly journal: BootstrapRequestJournal,
    private readonly binding: () => unknown,
    private readonly verifyPreparedBytes: (plan: CoordinatorBootstrapPlan) => Promise<void>,
    private readonly now: () => number = Date.now,
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
    const input = CoordinatorBootstrapPreparationSchema.parse(value);
    const binding = this.readBinding(input.plan);
    const expected = this.read();
    const digest = coordinatorPlanDigest(input.plan);
    const existing = expected.find((item) => item.id === input.id);
    if (existing) {
      if (existing.planSha256 !== digest || existing.reason !== input.reason)
        throw new BootstrapRequestConflict("This request ID already names different prepared work");
      return existing;
    }
    if (expected.some((item) => item.status !== "canceled"))
      throw new BootstrapRequestConflict("A coordinator bootstrap request is already open");
    await this.verifyPreparedBytes(input.plan);
    this.requireSameBinding(binding, input.plan);
    const request: CoordinatorBootstrapRequest = {
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
    if (input.decision === "approve") await this.verifyPreparedBytes(request.plan);
    this.requireSameBinding(binding, request.plan);
    const next: CoordinatorBootstrapRequest = {
      ...request,
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
    if (!transitions[request.execution.stage].includes(stage))
      throw new BootstrapRequestConflict("Invalid bootstrap dispatch transition");
    const next: CoordinatorBootstrapRequest = {
      ...request,
      revision: randomUUID(),
      execution: { ...request.execution, stage, updatedAt: new Date(this.now()).toISOString() },
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
