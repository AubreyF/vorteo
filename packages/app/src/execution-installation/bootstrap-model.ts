import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapDecision,
  CoordinatorBootstrapStage,
} from "@getpaseo/protocol/coordinator-bootstrap";

export interface BootstrapReviewClient {
  listCoordinatorBootstrapRequests(): Promise<CoordinatorBootstrapRequest[]>;
  decideCoordinatorBootstrap(
    input: CoordinatorBootstrapDecision,
    password: string,
  ): Promise<CoordinatorBootstrapRequest[]>;
}

interface BootstrapPanelState {
  available: boolean;
  requests: CoordinatorBootstrapRequest[];
  busy: boolean;
  hasPassword: boolean;
  passwordEpoch: number;
  error: string | null;
}

export class BootstrapPanelModel {
  private state: BootstrapPanelState = {
    available: false,
    requests: [],
    busy: false,
    hasPassword: false,
    passwordEpoch: 0,
    error: null,
  };
  private listeners = new Set<() => void>();
  private password = "";
  private refreshing = false;
  private generation = 0;
  constructor(private readonly resolveClient: () => BootstrapReviewClient | null) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<BootstrapPanelState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setPassword(value: string) {
    this.password = value;
    this.publish({ hasPassword: value.length > 0 });
  }
  async refresh(automatic = false) {
    if (this.refreshing || this.state.busy) return;
    const client = this.resolveClient();
    if (!client) {
      if (this.state.available)
        this.publish({
          error: "Host connection unavailable. Last known coordinator status is shown.",
        });
      return;
    }
    this.refreshing = true;
    const generation = this.generation;
    try {
      const requests = await client.listCoordinatorBootstrapRequests();
      if (generation === this.generation)
        this.publish({ available: true, requests, error: automatic ? this.state.error : null });
    } catch {
      if (generation === this.generation)
        this.publish({
          available: true,
          error: "Could not refresh coordinator status. Reconnect Host and retry.",
        });
    } finally {
      this.refreshing = false;
    }
  }
  async decide(request: CoordinatorBootstrapRequest, decision: "approve" | "cancel") {
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
    this.generation++;
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
      this.publish({ available: true, requests });
    } catch {
      this.publish({
        error:
          "Decision unconfirmed. Refresh status before retrying, then check the owner password.",
      });
    } finally {
      this.publish({ busy: false });
    }
  }
}

export function bootstrapDecisionDisabledReason(
  request: CoordinatorBootstrapRequest,
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
};
export function bootstrapStatus(request: CoordinatorBootstrapRequest): string {
  if (request.execution) return stageLabels[request.execution.stage];
  if (request.status === "canceled") return "Canceled";
  if (request.status === "approved") return "Approved; awaiting dispatch";
  return "Approval needed";
}
export function bootstrapNeedsAttention(request: CoordinatorBootstrapRequest): boolean {
  if (request.status === "canceled") return false;
  return request.execution?.stage !== "succeeded" && request.execution?.stage !== "resumed";
}
