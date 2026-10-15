import type {
  CoordinatorBootstrapRequestView as CoordinatorBootstrapRequest,
  CoordinatorBootstrapDecision,
  CoordinatorBootstrapStage,
  BootstrapPreclaimRecoveryRequestView as BootstrapPreclaimRecoveryRequest,
  BootstrapClaimedRecoveryRequestView,
} from "@getpaseo/protocol/coordinator-bootstrap";

export type BootstrapRecoveryRequest =
  | BootstrapPreclaimRecoveryRequest
  | BootstrapClaimedRecoveryRequestView;
type BootstrapReviewRequest = CoordinatorBootstrapRequest | BootstrapRecoveryRequest;

export interface BootstrapReviewClient<
  Request extends BootstrapReviewRequest = CoordinatorBootstrapRequest,
> {
  listCoordinatorBootstrapRequests(): Promise<Request[]>;
  verifyRetainedOutcome?(input: {
    id: string;
    revision: string;
    planSha256: string;
    generation: string;
  }): Promise<Request[]>;
  decideCoordinatorBootstrap(
    input: CoordinatorBootstrapDecision,
    password: string,
  ): Promise<Request[]>;
}

interface BootstrapPanelState<
  Request extends BootstrapReviewRequest = CoordinatorBootstrapRequest,
> {
  available: boolean;
  requests: Request[];
  busy: boolean;
  hasPassword: boolean;
  passwordEpoch: number;
  error: string | null;
}

export class BootstrapPanelModel<
  Request extends BootstrapReviewRequest = CoordinatorBootstrapRequest,
> {
  private state: BootstrapPanelState<Request> = {
    available: false,
    requests: [],
    busy: false,
    hasPassword: false,
    passwordEpoch: 0,
    error: null,
  };
  private listeners = new Set<() => void>();
  private password = "";
  private refreshToken: symbol | null = null;
  private availabilityError: string | null = null;
  private refreshError: string | null = null;
  private generation = 0;
  private pendingDecision: { id: string; revision: string } | null = null;
  constructor(
    private readonly resolveClient: () => BootstrapReviewClient<Request> | null,
    private readonly unavailableReason: () => string | null = () => null,
  ) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<BootstrapPanelState<Request>>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setPassword(value: string) {
    this.password = value;
    this.publish({ hasPassword: value.length > 0 });
  }
  async refresh(automatic = false) {
    const unavailable = this.unavailableReason();
    if (unavailable) {
      this.availabilityError = unavailable;
      this.generation++;
      this.refreshToken = null;
      this.pendingDecision = null;
      this.password = "";
      this.publish({
        available: true,
        requests: [],
        busy: false,
        error: unavailable,
        hasPassword: false,
        passwordEpoch: this.state.passwordEpoch + 1,
      });
      return;
    }
    if (this.refreshToken) return;
    const client = this.resolveClient();
    if (!client) {
      this.refreshError = "Host connection unavailable. Last known coordinator status is shown.";
      if (this.state.available)
        this.publish({
          error: this.refreshError,
        });
      return;
    }
    const refreshToken = Symbol();
    this.refreshToken = refreshToken;
    const generation = this.generation;
    try {
      const requests = await client.listCoordinatorBootstrapRequests();
      if (this.refreshToken === refreshToken && generation === this.generation) {
        const error =
          automatic &&
          this.state.error !== this.availabilityError &&
          this.state.error !== this.refreshError
            ? this.state.error
            : null;
        this.availabilityError = null;
        this.refreshError = null;
        const pending = this.pendingDecision;
        const recorded = pending && requests.find((item) => item.id === pending.id);
        // A durable revision supersedes the long-running decision response.
        // Keep polling during verification so approval and cancellation stay visible.
        if (pending && recorded && recorded.revision !== pending.revision) {
          this.generation++;
          this.pendingDecision = null;
          this.publish({ available: true, requests, busy: false, error: null });
        } else {
          this.publish({ available: true, requests, error });
        }
      }
    } catch {
      if (this.refreshToken === refreshToken && generation === this.generation) {
        this.refreshError = "Could not refresh coordinator status. Reconnect Host and retry.";
        this.publish({
          available: true,
          error: this.refreshError,
        });
      }
    } finally {
      if (this.refreshToken === refreshToken) this.refreshToken = null;
    }
  }
  canReconcile = () => typeof this.resolveClient()?.verifyRetainedOutcome === "function";

  async reconcile(request: Request) {
    if (this.state.busy || !request.execution || this.unavailableReason()) return;
    const client = this.resolveClient();
    if (!client?.verifyRetainedOutcome) {
      this.publish({ error: "Update the Host to verify a retained recovery outcome." });
      return;
    }
    const current = this.state.requests.find((item) => item.id === request.id);
    if (current?.revision !== request.revision || current.planSha256 !== request.planSha256) {
      this.publish({ error: "Recovery changed. Refresh before verifying its outcome." });
      return;
    }
    const generation = ++this.generation;
    this.publish({ busy: true, error: null });
    try {
      const requests = await client.verifyRetainedOutcome({
        id: request.id,
        revision: request.revision,
        planSha256: request.planSha256,
        generation: request.execution.generation,
      });
      if (generation === this.generation) this.publish({ requests });
    } catch {
      if (generation === this.generation)
        this.publish({
          error:
            "Outcome verification unconfirmed. Refresh the retained receipt; no effects were replayed.",
        });
    } finally {
      if (generation === this.generation) this.publish({ busy: false });
    }
  }

  async decide(request: Request, decision: "approve" | "cancel") {
    if (this.unavailableReason()) {
      await this.refresh();
      return;
    }
    if (this.state.busy) return;
    const current = this.state.requests.find((item) => item.id === request.id);
    if (
      !current ||
      current.revision !== request.revision ||
      current.planSha256 !== request.planSha256
    ) {
      this.publish({ error: "This request changed. Review its current source before approving." });
      return;
    }
    const reason = bootstrapDecisionDisabledReason(current, this.state);
    if (reason) {
      this.publish({ error: reason });
      return;
    }
    const client = this.resolveClient();
    if (!client) {
      this.publish({ error: "Reconnect Host before deciding this request." });
      return;
    }
    const generation = ++this.generation;
    this.pendingDecision = { id: request.id, revision: request.revision };
    const password = this.password;
    this.password = "";
    this.publish({
      busy: true,
      error: null,
      hasPassword: false,
      passwordEpoch: this.state.passwordEpoch + 1,
    });
    try {
      const requests = await client.decideCoordinatorBootstrap(
        { id: request.id, revision: request.revision, planSha256: request.planSha256, decision },
        password,
      );
      if (generation === this.generation) this.publish({ available: true, requests });
    } catch {
      if (generation === this.generation)
        this.publish({
          error:
            "Decision unconfirmed. Refresh status before retrying, then check the owner password.",
        });
    } finally {
      if (generation === this.generation) {
        this.generation++;
        this.pendingDecision = null;
        this.publish({ busy: false });
      }
    }
  }
}

export function bootstrapDecisionDisabledReason(
  request: BootstrapReviewRequest,
  state: Pick<BootstrapPanelState, "busy" | "hasPassword">,
): string | null {
  if (state.busy) return "Waiting for the current decision to finish.";
  if (request.execution)
    return "This operation has dispatched. Wait for its result; recovery requires a separate reviewed request.";
  if (request.status === "canceled")
    return "This request was canceled. Prepare a new request if maintenance is still needed.";
  if (!state.hasPassword)
    return "Enter the installation owner password to approve or cancel this exact request.";
  return null;
}

const stageLabels: Record<CoordinatorBootstrapStage, string> = {
  claimed: "Preparing handoff",
  freeze_pending: "Pausing coordinator",
  frozen: "Checking pending work",
  unload_pending: "Replacing coordinator",
  unloaded: "Selecting replacement",
  selection_pending: "Selecting replacement",
  selected: "Starting replacement",
  start_pending: "Starting replacement",
  started: "Verifying replacement",
  verifying: "Verifying replacement",
  succeeded: "Coordinator updated",
  resume_pending: "Resuming coordinator",
  resumed: "Coordinator resumed; update not installed",
  recovery_required: "Recovery required",
  rollback_pending: "Restoring previous coordinator",
  rolled_back: "Previous coordinator restored; update not installed",
};
export function bootstrapStatus(request: CoordinatorBootstrapRequest): string {
  if (request.execution) return stageLabels[request.execution.stage];
  if (request.status === "canceled") return "Canceled";
  if (request.automaticStatus) return automaticLabels[request.automaticStatus.state];
  if (request.status === "approved") return "Approved; awaiting dispatch";
  return "Approval needed";
}

const automaticLabels = {
  waiting: "Automatic validation queued",
  checking: "Automatic check awaiting confirmation",
  "retry-wait": "Automatic check will retry",
  "review-required": "Automatic checks stopped; review required",
  "cancellation-window": "Automatically approved; cancellation available",
  "dispatch-ready": "Automatically approved; awaiting dispatch",
  "launch-unconfirmed": "Launch unconfirmed; recovery review required",
  "owner-approved": "Owner approved; awaiting dispatch",
  execution: "Executing coordinator maintenance",
  canceled: "Canceled",
};

export function bootstrapAutomaticDetail(request: CoordinatorBootstrapRequest): string | null {
  const status = request.automaticStatus;
  if (!status) return null;
  if (status.state === "canceled")
    return "This automatic request was canceled. It will not dispatch.";
  if (status.state === "execution")
    return status.authorization === "owner"
      ? "The owner approved this operation. Follow its execution status above."
      : "Your Host permission authorized this operation. Follow its execution status above.";
  if (status.state === "launch-unconfirmed")
    return "A launch was reserved, but execution is not confirmed. It will not launch again automatically. Inspect the retained request before recovery.";
  if (status.state === "review-required")
    return "Three checks ended without confirmation. Automatic retries have stopped. Review this request or cancel it before preparing a correction.";
  if (status.state === "cancellation-window" && status.dispatchAfter)
    return `Your Host permission authorized this request. Dispatch cannot begin before ${new Date(status.dispatchAfter).toLocaleTimeString()}. You can cancel before dispatch.`;
  if (status.state === "checking" && status.attempt)
    return `Automatic check ${status.attempt} of 3 has no confirmed result yet. A connection loss does not authorize another launch.`;
  if (status.state === "retry-wait" && status.nextCheckAt && status.attempt)
    return `Check ${status.attempt} of 3 was not confirmed. Another check is eligible after ${new Date(status.nextCheckAt).toLocaleTimeString()}. You can cancel before dispatch.`;
  if (status.authorization === "owner") return "The owner explicitly approved this request.";
  return "This request uses your separate Host-only coordinator permission. Cancellation remains available until dispatch is claimed.";
}

export function bootstrapRequiresOwnerAction(request: CoordinatorBootstrapRequest): boolean {
  if (request.execution) return request.execution.stage === "recovery_required";
  if (request.status === "canceled") return false;
  if (request.automaticStatus)
    return (
      request.automaticStatus.state === "review-required" ||
      request.automaticStatus.state === "launch-unconfirmed"
    );
  return request.status === "pending";
}
export function bootstrapNeedsAttention(request: CoordinatorBootstrapRequest): boolean {
  if (request.status === "canceled") return false;
  return (
    request.execution?.stage !== "succeeded" &&
    request.execution?.stage !== "resumed" &&
    request.execution?.stage !== "rolled_back"
  );
}

/** Keep failed receipts in the journal while the fresh review owns the active callout. */
export function currentBootstrapRequests(
  requests: CoordinatorBootstrapRequest[],
): CoordinatorBootstrapRequest[] {
  const superseded = new Set(
    requests
      .filter((request) => request.status !== "canceled")
      .map((request) => request.plan.recoveredFrom?.id)
      .filter((id) => id !== undefined),
  );
  return requests.filter((request) => !superseded.has(request.id));
}

export function preclaimRecoveryStatus(request: BootstrapRecoveryRequest): string {
  if (!request.execution) {
    if (request.status === "canceled") return "Canceled";
    return request.status === "approved"
      ? "Approved; awaiting recorded claim"
      : "Recovery approval needed";
  }
  const labels: Record<NonNullable<BootstrapRecoveryRequest["execution"]>["stage"], string> = {
    claimed: "Checking recovery",
    cancellation_fenced: "Original operation canceled",
    claim_fenced: "Original operation cannot dispatch",
    effect_pending: "Stopping the reviewed executor",
    verifying: "Verifying exit and preserved selection",
    succeeded: "Executor cleanup verified",
    recovery_required: "Outcome requires inspection",
    aborted_before_effects: "Stopped before effects",
  };
  return labels[request.execution.stage];
}

export function preclaimDispatchDescription(request: BootstrapRecoveryRequest): string | null {
  const observation = request.dispatch;
  if (!observation) return null;
  switch (observation.state) {
    case "no_receipt":
      return "No launch receipt recorded.";
    case "attempt_retained":
      return "Launch attempt retained; a runner birth receipt is not yet available.";
    case "birth_retained":
      return `Recovery runner birth recorded: PID ${observation.executor.pid}, start ${observation.executor.startIdentity}. Current liveness and completion still require verification.`;
    case "unavailable":
      return "Launch receipts could not be reconciled. Inspect retained evidence; do not replay approval.";
  }
}

export function preclaimRecoveryNeedsAttention(request: BootstrapRecoveryRequest): boolean {
  return (
    request.status !== "canceled" &&
    request.execution?.stage !== "succeeded" &&
    request.execution?.stage !== "aborted_before_effects"
  );
}

export function recoveryTargetDescription(request: BootstrapRecoveryRequest): string {
  const { plan } = request;
  if (plan.operation === "bootstrap-claimed-recovery")
    return `Prevent the stalled operation from dispatching and stop only its reviewed executor, PID ${plan.executor.identity.pid}. Preserve its original approval and recovery history. The selected coordinator and configuration stay in place. Host and Dev tasks keep running.`;
  const action = plan.ownerCancellation
    ? `Preserve owner cancellation ${plan.ownerCancellation.revision} recorded ${plan.ownerCancellation.decisionAt} for operation ${plan.original.id}`
    : `Cancel original operation ${plan.original.id}`;
  return `${action} and stop only its reviewed executor, PID ${plan.executor.identity.pid}. The selected coordinator and configuration stay in place. Host and Dev tasks keep running.`;
}
