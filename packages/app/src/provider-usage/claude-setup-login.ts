import { z } from "zod";
import { ProviderLoginStateSchema } from "@getpaseo/protocol/provider-login";
import {
  InstallationRouteUnavailable,
  OwnerAccessExpired,
  requestInstallationOwner,
} from "@/execution-installation/client";
import { requestInstallationSettings } from "@/execution-installation/settings";

const EnvironmentStatusSchema = z.strictObject({
  serverId: z.string(),
  status: z.enum(["ready", "pending", "excluded", "disconnected", "disconnecting"]),
});
export const ClaudeSetupConnectionSchema = z.strictObject({
  connected: z.boolean(),
  environments: z.array(EnvironmentStatusSchema),
  /** Full sign-in only: the Host account's email, so the owner can confirm the right account. */
  accountLabel: z.string().optional(),
  /** Full sign-in only: the Host grant disappeared or stopped refreshing. */
  needsSignIn: z.boolean().optional(),
});
const ReadSchema = z.strictObject({
  login: ProviderLoginStateSchema,
  connection: ClaudeSetupConnectionSchema,
});
// Host-refresh status. Parsed leniently so newer coordinators can add fields.
const FullReadSchema = z.object({
  login: ProviderLoginStateSchema,
  connection: z.object({
    signedIn: z.boolean(),
    needsSignIn: z.boolean(),
    identity: z.object({ email: z.string().nullable() }).nullable(),
    environments: z.array(EnvironmentStatusSchema),
  }),
});

/** Resolve exact shared bindings, never account labels or cached native-login identities. */
async function claudeDefinition(serverId: string, providerId: string) {
  const snapshot = await requestInstallationSettings();
  const definitions = snapshot.settings?.providerDefinitions?.filter(
    (item) =>
      item.providerType === "claude" && !item.removed && item.bindings[serverId] === providerId,
  );
  if (!definitions || definitions.length !== 1)
    throw new Error("Refresh shared account settings before connecting Claude.");
  return definitions[0]!;
}

/**
 * Full sign-in accounts use the coordinator's Host-refresh routes; setup-token accounts keep
 * the setup-token routes. The account type comes from the shared definition, never the client.
 */
export async function claudeSetupRequest(
  serverId: string,
  providerId: string,
  operation: "read" | "start" | "submit" | "cancel" | "sign-out",
  attempt?: { attemptId: string; code?: string },
) {
  const definition = await claudeDefinition(serverId, providerId);
  const full = definition.accountSetup?.signIn === "full";
  const result = await requestInstallationOwner(
    `claude/${full ? "oauth" : "setup-token"}/${operation}`,
    "",
    { definitionId: definition.id, ...attempt },
  );
  if (operation !== "read" && operation !== "sign-out")
    return { login: ProviderLoginStateSchema.parse(result), connection: undefined };
  if (!full) return ReadSchema.parse(result);
  const { login, connection } = FullReadSchema.parse(result);
  return {
    login,
    connection: {
      connected: connection.signedIn && !connection.needsSignIn,
      environments: connection.environments,
      needsSignIn: connection.needsSignIn,
      ...(connection.identity?.email ? { accountLabel: connection.identity.email } : {}),
    },
  };
}

/**
 * Whether the coordinator runs Host-owned Claude refresh. Its owner routes exist only when the
 * installation enables it. An unknown definition is refused (409) by a coordinator that has
 * the routes, while one without them answers 404 or its page fallback.
 */
export async function claudeFullSignInAvailable(): Promise<boolean> {
  try {
    await requestInstallationOwner("claude/oauth/read", "", { definitionId: "availability" });
    return false;
  } catch (error) {
    if (error instanceof OwnerAccessExpired) throw error;
    return !(error instanceof InstallationRouteUnavailable);
  }
}
