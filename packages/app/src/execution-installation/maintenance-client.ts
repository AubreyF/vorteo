import { z } from "zod";
import {
  CoordinatorMaintenanceStatusSchema,
  CoordinatorBootstrapListResponseSchema,
  CoordinatorBootstrapDecideResponseSchema,
  type CoordinatorBootstrapInbound,
  type CoordinatorBootstrapRequestView,
  type CoordinatorBootstrapDecision,
} from "@getpaseo/protocol/coordinator-bootstrap";
import type { BootstrapReviewClient } from "./bootstrap-model";

const ResponseSchema = z.discriminatedUnion("type", [
  CoordinatorBootstrapListResponseSchema,
  CoordinatorBootstrapDecideResponseSchema,
]);
interface MaintenanceClientPorts {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
}

/** The maintenance transport advertises its own readiness. Never infer support from
 * an old Host capability or erase retained status when a known route disappears. */
export class MaintenanceClient implements BootstrapReviewClient<CoordinatorBootstrapRequestView> {
  private observed = false;
  private retryAt = 0;
  private sequence = 0;
  constructor(
    private readonly installationId: string,
    private readonly ports: MaintenanceClientPorts,
  ) {}

  async status() {
    if (!this.observed && this.ports.now() < this.retryAt) return null;
    const response = await this.ports.fetch("/api/installation/maintenance/status", {
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
    });
    const absent =
      response.status === 404 ||
      (response.ok && !response.headers.get("content-type")?.includes("application/json"));
    if (absent && !this.observed) {
      this.retryAt = this.ports.now() + 60_000;
      return null;
    }
    if (!response.ok || absent)
      throw new Error("Previously available maintenance controls are unreachable");
    const status = CoordinatorMaintenanceStatusSchema.parse(await response.json());
    if (status.installationId !== this.installationId)
      throw new Error("Maintenance belongs to another installation");
    this.observed = true;
    return status;
  }

  async listCoordinatorBootstrapRequests() {
    const status = await this.status();
    if (!status || (!status.available && status.requests === 0)) return [];
    return this.request({
      type: "installation.bootstrap.list_requests.request",
      compatibleRecovery: true,
      bootRecovery: true,
      automaticStatus: true,
      requestId: String(++this.sequence),
    });
  }
  async decideCoordinatorBootstrap(input: CoordinatorBootstrapDecision, password: string) {
    const status = await this.status();
    if (!status?.available || status.provisioning.requestId !== input.id)
      throw new Error("Maintenance review is unavailable or changed");
    return this.request(
      {
        type: "installation.bootstrap.decide.request",
        requestId: String(++this.sequence),
        input,
        ownerPassword: password,
        compatibleRecovery: true,
        bootRecovery: true,
        automaticStatus: true,
      },
      password,
    );
  }
  async provision(admissionSha256: string, password: string) {
    const status = await this.status();
    if (
      !status ||
      status.provisioning.admissionSha256 !== admissionSha256 ||
      status.phase === "validating" ||
      status.requests > 0
    )
      throw new Error("Maintenance provisioning changed; refresh its retained status");
    const response = await this.ports.fetch("/api/installation/maintenance/owner", {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
      body: JSON.stringify({
        type: "installation.maintenance.provision.request",
        admissionSha256,
        ownerPassword: password,
      }),
    });
    if (!response.ok || (await response.json()).provisioned !== true)
      throw new Error(
        "Maintenance provisioning was not confirmed. Inspect retained status before retrying.",
      );
  }
  private async request(message: CoordinatorBootstrapInbound, password?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (password) headers.Authorization = `Bearer ${password}`;
    const response = await this.ports.fetch("/api/installation/maintenance/owner", {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error("Unlock Installation controls to inspect the maintenance");
    const result = ResponseSchema.parse(await response.json());
    if (
      result.type !== message.type.replace(/\.request$/, ".response") ||
      result.payload.requestId !== message.requestId
    )
      throw new Error("Maintenance response does not match this request");
    if (result.payload.error !== null || result.payload.requests === null)
      throw new Error(result.payload.error ?? "Maintenance response is incomplete");
    if (
      result.payload.requests.some((request) => request.plan.installationId !== this.installationId)
    )
      throw new Error("Maintenance response belongs to another installation");
    return result.payload.requests;
  }
}
