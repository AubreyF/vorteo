import { z } from "zod";
import {
  InstallationUnlockSchema,
  RestartJobSchema,
  ProfileSharingStatusSchema,
  type ProfileSharingStatus,
  type ExecutionInstallation,
  type RestartJob,
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
  request(path: string, password: string, body: unknown): Promise<unknown>;
  register: Pick<HostRuntimeStore, "installExecutionEnvironments">;
}

export class OwnerAccessExpired extends Error {}

export class InstallationClient {
  private password: string | null = null;
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

  async listRestarts(): Promise<RestartJob[]> {
    return z.array(RestartJobSchema).parse(await this.request("restarts/query", {}));
  }

  async decide(job: RestartJob, decision: "approve" | "reject"): Promise<void> {
    RestartJobSchema.parse(
      await this.request(`restarts/${job.id}/decision`, { revision: job.revision, decision }),
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
    return this.ports.request(path, this.password, body);
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
  if (response.status === 401)
    throw path === "unlock"
      ? new Error("Incorrect owner password. Use the password generated by the host installer.")
      : new OwnerAccessExpired("Owner access expired or was locked. Unlock controls to continue.");
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
