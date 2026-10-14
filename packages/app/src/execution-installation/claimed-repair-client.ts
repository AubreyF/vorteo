import { z } from "zod";
import {
  BootstrapClaimedRepairStatusSchema,
  BootstrapClaimedRecoveryListResponseSchema,
  BootstrapClaimedRecoveryDecideResponseSchema,
  type BootstrapClaimedRecoveryInbound,
  type BootstrapClaimedRecoveryRequestView,
  type BootstrapClaimedObservation,
  type CoordinatorBootstrapDecision,
} from "@getpaseo/protocol/coordinator-bootstrap";
import type { BootstrapReviewClient } from "./bootstrap-model";

const ResponseSchema = z.discriminatedUnion("type", [
  BootstrapClaimedRecoveryListResponseSchema,
  BootstrapClaimedRecoveryDecideResponseSchema,
]);
interface RepairClientPorts {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
}

/** The repair transport advertises its own readiness. Never infer support from
 * an old Host capability or erase retained status when a known route disappears. */
export class ClaimedRepairClient implements BootstrapReviewClient<BootstrapClaimedRecoveryRequestView> {
  private observed = false;
  private retryAt = 0;
  private sequence = 0;
  constructor(
    private readonly installationId: string,
    private readonly ports: RepairClientPorts,
  ) {}

  private async discover(): Promise<boolean> {
    if (!this.observed && this.ports.now() < this.retryAt) return false;
    const response = await this.ports.fetch("/api/installation/claimed-repair/status", {
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
    });
    const absent =
      response.status === 404 ||
      (response.ok && !response.headers.get("content-type")?.includes("application/json"));
    if (absent && !this.observed) {
      this.retryAt = this.ports.now() + 60_000;
      return false;
    }
    if (!response.ok || absent)
      throw new Error("Previously available repair controls are unreachable");
    const status = BootstrapClaimedRepairStatusSchema.parse(await response.json());
    if (status.installationId !== this.installationId)
      throw new Error("Repair belongs to another installation");
    if (!status.available && status.provisioning && !this.observed) return false;
    this.observed = true;
    if (!status.available) throw new Error("Provisioned repair is unavailable");
    return true;
  }

  async listCoordinatorBootstrapRequests() {
    if (!(await this.discover())) return [];
    return this.request({
      type: "installation.claimed_recovery.list_requests.request",
      requestId: String(++this.sequence),
    });
  }
  async verifyRetainedOutcome(reconcile: BootstrapClaimedObservation) {
    if (!(await this.discover())) throw new Error("Provisioned repair is unavailable");
    return this.request({
      type: "installation.claimed_recovery.list_requests.request",
      requestId: String(++this.sequence),
      reconcile,
    });
  }
  async decideCoordinatorBootstrap(input: CoordinatorBootstrapDecision, password: string) {
    if (!(await this.discover())) throw new Error("Provisioned repair is unavailable");
    return this.request(
      {
        type: "installation.claimed_recovery.decide.request",
        requestId: String(++this.sequence),
        input,
        ownerPassword: password,
        claimedRecovery: true,
      },
      password,
    );
  }
  private async request(message: BootstrapClaimedRecoveryInbound, password?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (password) headers.Authorization = `Bearer ${password}`;
    const response = await this.ports.fetch("/api/installation/claimed-repair/owner", {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error("Unlock Installation controls to inspect the repair");
    const result = ResponseSchema.parse(await response.json());
    if (
      result.type !== message.type.replace(/\.request$/, ".response") ||
      result.payload.requestId !== message.requestId
    )
      throw new Error("Repair response does not match this request");
    if (result.payload.error !== null || result.payload.requests === null)
      throw new Error(result.payload.error ?? "Repair response is incomplete");
    if (
      result.payload.requests.some(
        (request) => request.plan.original.plan.installationId !== this.installationId,
      )
    )
      throw new Error("Repair response belongs to another installation");
    return result.payload.requests;
  }
}
