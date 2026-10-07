import { z } from "zod";
import {
  ProviderPreferencesSchema,
  SharedProviderPreferencesSchema,
} from "./provider-preferences.js";

export const ExecutionEnvironmentKindSchema = z.enum(["container", "host"]);
export type ExecutionEnvironmentKind = z.infer<typeof ExecutionEnvironmentKindSchema>;

export const InstallationEnvironmentSchema = z.strictObject({
  kind: ExecutionEnvironmentKindSchema,
  serverId: z.string().min(1),
  endpoint: z.string().min(1),
  useTls: z.boolean(),
});
export type InstallationEnvironment = z.infer<typeof InstallationEnvironmentSchema>;

// This descriptor comes from the installed UI origin, never from an agent daemon.
// Credentials are exchanged only after owner authentication, not in the HTML.
export const ExecutionInstallationSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  profileSharing: z.boolean().optional(),
  idleRestarts: z.boolean().optional(),
  gracefulRestarts: z.boolean().optional(),
  origin: z.url(),
  environments: z.array(InstallationEnvironmentSchema).length(2),
});
export type ExecutionInstallation = z.infer<typeof ExecutionInstallationSchema>;

export const InstallationConnectionSchema = InstallationEnvironmentSchema.extend({
  password: z.string().min(1),
});
export const InstallationUnlockSchema = z.strictObject({
  installationId: z.string().uuid(),
  connections: z.array(InstallationConnectionSchema).length(2),
});
export type InstallationUnlock = z.infer<typeof InstallationUnlockSchema>;

export const RestartTargetSchema = z.enum(["host", "container-daemon"]);
export const RestartRequestSchema = z.strictObject({
  target: RestartTargetSchema,
  reason: z.string().trim().min(1).max(2000),
  requester: z.string().trim().min(1).max(200).optional(),
});
export type RestartRequest = z.infer<typeof RestartRequestSchema>;

export const RestartSummarySchema = z.object({
  requested: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type RestartSummary = z.infer<typeof RestartSummarySchema>;

export const RestartImpactSchema = z.object({
  target: RestartTargetSchema,
  checkedAt: z.string().datetime(),
  agents: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
  pendingStarts: z.number().int().nonnegative(),
  idleRestartSupported: z.boolean(),
  gracefulRestartSupported: z.boolean().optional(),
  error: z.string().nullable(),
});
export type RestartImpact = z.infer<typeof RestartImpactSchema>;

export const RestartJobSchema = RestartRequestSchema.extend({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.enum(["owner", "host-agent", "container-agent"]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  detail: z.string(),
  whenIdle: z.boolean().optional(),
  finishCurrentTurns: z.boolean().optional(),
  holdReleased: z.boolean().optional(),
  approvedAt: z.string().datetime().optional(),
  impact: RestartImpactSchema.optional(),
});
export type RestartJob = z.infer<typeof RestartJobSchema>;

export const RestartDecisionSchema = z.strictObject({
  revision: z.string().uuid(),
  decision: z.enum([
    "approve",
    "reject",
    "approve-when-idle",
    "finish-current-turns",
    "request-again",
    "cancel",
  ]),
});

export type RestartDecision = z.infer<typeof RestartDecisionSchema>["decision"];

export const EXECUTION_ENVIRONMENT_LABELS: Record<ExecutionEnvironmentKind, string> = {
  container: "Dev container",
  host: "Host: full account access",
};

export function validateExecutionInstallation(input: unknown): ExecutionInstallation {
  const installation = ExecutionInstallationSchema.parse(input);
  const origin = new URL(installation.origin);
  if (origin.origin !== installation.origin)
    throw new Error("Installation origin must be an origin");
  const isLoopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopback)) {
    throw new Error("Remote installation connections require HTTPS");
  }
  const kinds = new Set(installation.environments.map((environment) => environment.kind));
  const ids = new Set(installation.environments.map((environment) => environment.serverId));
  const endpoints = new Set(installation.environments.map((environment) => environment.endpoint));
  if (kinds.size !== 2 || ids.size !== 2 || endpoints.size !== 2) {
    throw new Error("Installation requires distinct host and container identities and endpoints");
  }
  for (const environment of installation.environments) {
    const endpoint = new URL(`https://${environment.endpoint}`);
    if (endpoint.host !== environment.endpoint || endpoint.username || endpoint.password) {
      throw new Error("Environment endpoint must contain only a host and optional port");
    }
    const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
    if (!environment.useTls && !local)
      throw new Error("Remote environment connections require TLS");
  }
  return installation;
}

export const ProfileSharingStatusSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  sources: z.record(
    z.string(),
    z.object({
      error: z.string().nullable(),
      conflicts: z.array(z.string()),
      conflictValues: z.array(
        z.object({ field: z.string(), sharedValue: z.string(), environmentValue: z.string() }),
      ),
    }),
  ),
});
export type ProfileSharingStatus = z.infer<typeof ProfileSharingStatusSchema>;

export const InstallationProfilesSnapshotSchema = ProfileSharingStatusSchema.extend({
  workerAccounts: z.boolean().optional(),
  providers: z.record(z.string(), ProviderPreferencesSchema),
});
export type InstallationProfilesSnapshot = z.infer<typeof InstallationProfilesSnapshotSchema>;

export const InstallationProfilesPatchSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  providers: z.record(z.string(), ProviderPreferencesSchema),
});
export type InstallationProfilesPatch = z.infer<typeof InstallationProfilesPatchSchema>;

export const InstallationProfilesAdmissionSchema = z.strictObject({
  installationId: z.string().uuid(),
  environment: ExecutionEnvironmentKindSchema,
  serverId: z.string().min(1),
  preferences: SharedProviderPreferencesSchema,
});
export type InstallationProfilesAdmission = z.infer<typeof InstallationProfilesAdmissionSchema>;
