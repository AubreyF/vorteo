import {
  NativeHelperJobSchema,
  type NativeHelperJob,
} from "@getpaseo/protocol/native-helper-maintenance";
import {
  InstallationEnrollmentStatusSchema,
  type InstallationEnrollmentStatus,
} from "@getpaseo/protocol/installation-enrollment";
import {
  PreviewMonitorJobSchema,
  type PreviewMonitorJob,
} from "@getpaseo/protocol/preview-monitor-maintenance";
import type { MonitorAction } from "./preview-monitor-review";
import type { HelperReviewAction } from "./helper-review";
import { z } from "zod";
import {
  InstallationMaintenanceStatusSchema,
  type InstallationMaintenanceStatus,
  DaemonAutomationPreferenceSchema,
  type DaemonAutomationPreference,
  type MaintenanceService,
  InstallationUnlockSchema,
  RestartSummarySchema,
  type RestartSummary,
  RestartJobSchema,
  ProfileSharingStatusSchema,
  type ProfileSharingStatus,
  type ExecutionInstallation,
  type RestartJob,
  type RestartDecision,
} from "@getpaseo/protocol/execution-installation";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { normalizeHostPort } from "@getpaseo/protocol/daemon-endpoints";

export function hasInstallationConnections(
  installation: ExecutionInstallation,
  profiles: readonly Pick<HostProfile, "serverId" | "connections" | "password">[],
): boolean {
  return installation.environments.every((environment) => {
    const scheme = environment.useTls ? "https" : "http";
    const address = new URL(`${scheme}://${environment.endpoint}`);
    const port = address.port || (environment.useTls ? "443" : "80");
    const endpoint = normalizeHostPort(`${address.hostname}:${port}`);
    const profile = profiles.find((candidate) => candidate.serverId === environment.serverId);
    return (
      profile?.connections.some((connection) => {
        if (connection.type !== "directTcp") return false;
        return (
          connection.endpoint === endpoint &&
          connection.useTls === environment.useTls &&
          Boolean(profile.password)
        );
      }) ?? false
    );
  });
}

export interface InstallationClientPorts {
  now?(): number;
  request(path: string, password: string, body: unknown): Promise<unknown>;
  register: Pick<HostRuntimeStore, "installExecutionEnvironments">;
}

export class OwnerAccessExpired extends Error {}
export class InstallationRouteUnavailable extends Error {}

export class InstallationClient {
  private password: string | null = null;
  private helperRetryAt = 0;
  private daemonAutomationSupported = false;
  private servicePermissionsSupported = false;
  private maintenanceStatusSupported = false;
  private enrollmentStatusSupported = false;
  private devRepairSupported = false;
  private devRepairAvailable = false;
  private monitorRetryAt = 0;
  sessionsSupported = false;
  passwordFile: string | null = null;

  async restoreSession(): Promise<boolean> {
    const response = await fetch("/api/installation/owner-access", {
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("Unable to check installation owner access");
    const metadata = z
      .strictObject({ sessions: z.literal(true), passwordFile: z.string().nullable() })
      .parse(await response.json());
    this.sessionsSupported = true;
    this.passwordFile = metadata.passwordFile;
    const session = z
      .strictObject({ authenticated: z.boolean(), expiresAt: z.string().nullable() })
      .parse(await this.ports.request("session", "", {}));
    if (!session.authenticated) return false;
    await this.installConnections(await this.ports.request("connections", "", {}));
    this.password = "";
    return true;
  }

  async lock(): Promise<void> {
    if (this.sessionsSupported) await this.request("lock", {});
    this.password = null;
  }

  constructor(
    private readonly installation: ExecutionInstallation,
    private readonly ports: InstallationClientPorts,
  ) {}

  async unlock(password: string): Promise<void> {
    await this.installConnections(await this.ports.request("unlock", password, {}));
    this.password = this.sessionsSupported ? "" : password;
  }

  private async installConnections(payload: unknown): Promise<void> {
    const result = InstallationUnlockSchema.parse(payload);
    if (result.installationId !== this.installation.installationId)
      throw new Error("Installation identity changed");
    for (const environment of this.installation.environments) {
      const connection = result.connections.find(
        (candidate) => candidate.kind === environment.kind,
      );
      if (
        !connection ||
        connection.serverId !== environment.serverId ||
        connection.endpoint !== environment.endpoint ||
        connection.useTls !== environment.useTls
      ) {
        throw new Error("Installation connection does not match its reviewed environment");
      }
    }
    await this.ports.register.installExecutionEnvironments(result.connections);
  }

  async restartSummary(): Promise<RestartSummary | null> {
    if (!this.installation.idleRestarts) return null;
    const response = await fetch("/api/installation/restart-summary", {
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Unable to check restart requests");
    return RestartSummarySchema.parse(await response.json());
  }

  async listMonitors(): Promise<PreviewMonitorJob[]> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (now() < this.monitorRetryAt) return [];
    try {
      return z
        .strictObject({ jobs: z.array(PreviewMonitorJobSchema) })
        .parse(await this.request("monitors/query", {})).jobs;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable) {
        this.monitorRetryAt = now() + 60_000;
        return [];
      }
      throw error;
    }
  }
  async decideMonitor(job: PreviewMonitorJob, decision: MonitorAction): Promise<PreviewMonitorJob> {
    const result = PreviewMonitorJobSchema.parse(
      await this.request("monitors/decision", {
        operation: job.operation,
        id: job.id,
        revision: job.revision,
        planSha256: job.planSha256,
        decision,
      }),
    );
    if (
      result.id !== job.id ||
      result.revision !== job.revision ||
      result.planSha256 !== job.planSha256
    )
      throw new Error("Monitor receipt changed. Refresh before another action.");
    return result;
  }
  async listHelpers(): Promise<NativeHelperJob[]> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (now() < this.helperRetryAt) return [];
    try {
      const result = z
        .strictObject({ jobs: z.array(NativeHelperJobSchema) })
        .parse(await this.request("helpers/query", {}));
      return result.jobs;
    } catch (error) {
      // COMPAT(nativeHelperMaintenance): old coordinators have no helper route.
      if (error instanceof InstallationRouteUnavailable) {
        // Keep discovering coordinator upgrades without probing an absent route every five seconds.
        this.helperRetryAt = now() + 60_000;
        return [];
      }
      throw error;
    }
  }

  async decideHelper(job: NativeHelperJob, action: HelperReviewAction): Promise<NativeHelperJob> {
    const identity = { id: job.id, revision: job.revision, planSha256: job.planSha256 };
    const result = NativeHelperJobSchema.parse(
      await this.request(
        action === "verify-installed" ? "helpers/verify-installed" : "helpers/decision",
        action === "verify-installed"
          ? { ...identity, operation: "native-helper-verify-installed" }
          : { ...identity, operation: job.operation, decision: action },
      ),
    );
    if (
      result.id !== job.id ||
      result.revision !== job.revision ||
      result.planSha256 !== job.planSha256
    )
      throw new Error("Helper receipt changed. Refresh status before taking another action.");
    return result;
  }

  async devRepairStatus(): Promise<{
    available: boolean;
    preparingIds: string[];
  }> {
    try {
      const result = z
        .strictObject({
          available: z.boolean(),
          preparingIds: z.array(z.string().uuid()),
        })
        .parse(await this.request("dev-repair/query", {}));
      this.devRepairSupported = true;
      this.devRepairAvailable = result.available;
      return result;
    } catch (error) {
      this.devRepairAvailable = false;
      if (error instanceof InstallationRouteUnavailable && !this.devRepairSupported)
        return { available: false, preparingIds: [] };
      throw error;
    }
  }

  async prepareDevRepair(job: RestartJob): Promise<void> {
    if (!this.devRepairAvailable) throw new Error("Update the coordinator to prepare Dev repairs");
    const receipt = z.strictObject({ id: z.string().uuid(), revision: z.string().uuid() }).parse(
      await this.request("dev-repair/prepare", {
        id: job.id,
        revision: job.revision,
      }),
    );
    if (receipt.id !== job.id)
      throw new Error("Dev repair receipt changed. Refresh before another action.");
  }

  async listRestarts(): Promise<RestartJob[]> {
    return z.array(RestartJobSchema).parse(await this.request("restarts/query", {}));
  }

  async decide(job: RestartJob, decision: RestartDecision): Promise<void> {
    if (
      (decision === "approve-when-idle" || decision === "cancel") &&
      !this.installation.idleRestarts
    )
      throw new Error("Update the installation coordinator to support queued idle restarts");
    if (
      ["finish-current-turns", "request-again"].includes(decision) &&
      !this.installation.gracefulRestarts
    )
      throw new Error("Update the coordinator to support this restart action");
    RestartJobSchema.parse(
      await this.request(`restarts/${job.id}/decision`, {
        revision: job.revision,
        decision,
        ...(job.update ? { updateSha256: job.update.sha256 } : {}),
        ...(job.supervisorPlanSha256 ? { supervisorPlanSha256: job.supervisorPlanSha256 } : {}),
        ...(job.factoryRuntimePlanSha256
          ? { factoryRuntimePlanSha256: job.factoryRuntimePlanSha256 }
          : {}),
      }),
    );
  }

  async maintenanceStatus(): Promise<InstallationMaintenanceStatus | null> {
    try {
      const status = InstallationMaintenanceStatusSchema.parse(
        await this.request("maintenance-status/query", {}),
      );
      this.maintenanceStatusSupported = true;
      return status;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.maintenanceStatusSupported)
        return null;
      throw error;
    }
  }

  async enrollmentStatus(): Promise<InstallationEnrollmentStatus | null> {
    try {
      const status = InstallationEnrollmentStatusSchema.parse(
        await this.request("enrollment/query", {}),
      );
      if (status.installationId !== this.installation.installationId)
        throw new Error("Installation status belongs to another installation");
      this.enrollmentStatusSupported = true;
      return status;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.enrollmentStatusSupported)
        return null;
      throw error;
    }
  }

  async daemonAutomation(): Promise<DaemonAutomationPreference | null> {
    try {
      let response: unknown;
      try {
        response = await this.request("maintenance-permissions/query", {});
        this.servicePermissionsSupported = true;
      } catch (error) {
        if (!(error instanceof InstallationRouteUnavailable) || this.servicePermissionsSupported)
          throw error;
        response = await this.request("daemon-automation/query", {});
      }
      const preference = DaemonAutomationPreferenceSchema.parse(response);
      this.daemonAutomationSupported = true;
      return preference;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.daemonAutomationSupported)
        return null;
      throw error;
    }
  }

  async changeDaemonAutomation(
    preference: DaemonAutomationPreference,
    enabled: boolean,
    service?: MaintenanceService,
  ): Promise<DaemonAutomationPreference> {
    if (!this.daemonAutomationSupported)
      throw new InstallationRouteUnavailable("Automatic daemon maintenance is unavailable");
    if (service && !preference.services)
      throw new InstallationRouteUnavailable(
        "Update the coordinator for separate service permissions",
      );
    return DaemonAutomationPreferenceSchema.parse(
      await this.request(service ? "maintenance-permissions/change" : "daemon-automation/change", {
        expectedRevision: preference.revision,
        enabled,
        ...(service ? { service } : {}),
      }),
    );
  }

  async profileSharingStatus(): Promise<ProfileSharingStatus | null> {
    if (this.installation.profileSharing !== true) return null;
    return ProfileSharingStatusSchema.nullable().parse(await this.request("profiles/query", {}));
  }

  async resolveProfileConflict(input: {
    serverId: string;
    expectedRevision: number;
    choice: "shared" | "environment";
  }): Promise<void> {
    ProfileSharingStatusSchema.parse(await this.request("profiles/resolve", input));
  }

  private request(path: string, body: unknown): Promise<unknown> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const resource =
      this.installation.idleRestarts && path.startsWith("restarts")
        ? `${path}?idleRestarts=1${this.installation.gracefulRestarts ? "&gracefulRestarts=1" : ""}`
        : path;
    const query = path.startsWith("restarts")
      ? `${resource}${resource.includes("?") ? "&" : "?"}sourceUpdates=1&sourceBatches=1&containerSourceUpdates=1&supervisorMaintenance=1&hostAutomaticRestarts=1&factoryRuntimeAdoption=1`
      : resource;
    return this.ports.request(query, this.password, body);
  }
}

export async function requestInstallationOwner(
  path: string,
  password: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`/api/installation/owner/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(password ? { Authorization: `Bearer ${password}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
  });
  // Older coordinators may serve their SPA fallback for an unknown owner query.
  // A client that already observed support still treats this as a lost capability.
  if (
    ["daemon-automation/query", "dev-repair/query"].includes(path) &&
    response.ok &&
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    throw new InstallationRouteUnavailable("Installation maintenance operation is unavailable");
  }
  if (response.status === 401)
    throw path === "unlock"
      ? new Error("Incorrect owner password. Use the password generated by the host installer.")
      : new OwnerAccessExpired("Owner access expired or was locked. Unlock controls to continue.");
  if (response.status === 404)
    throw new InstallationRouteUnavailable("Installation operation is unavailable");
  if (!response.ok) {
    const detail = z
      .object({ error: z.string().max(2000) })
      .safeParse(await response.json().catch(() => null));
    throw new Error(
      detail.success ? detail.data.error : `Installation request failed (${response.status})`,
    );
  }
  return response.json();
}
