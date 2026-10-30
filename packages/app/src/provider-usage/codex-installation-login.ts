import { z } from "zod";
import { ProviderLoginStateSchema } from "@getpaseo/protocol/provider-login";
import {
  InstallationRequestFailed,
  OwnerAccessExpired,
  requestInstallationOwner,
} from "@/execution-installation/client";
import { requestInstallationSettings } from "@/execution-installation/settings";
import type { ClaudeSetupConnectionSchema } from "./claude-setup-login";

const EnvironmentStatusSchema = z.strictObject({
  serverId: z.string(),
  status: z.enum(["ready", "pending", "excluded", "disconnected", "disconnecting"]),
});
// Host-owned sign-in status. Parsed leniently so newer coordinators can add fields.
const ReadSchema = z.object({
  login: ProviderLoginStateSchema,
  connection: z.object({
    signedIn: z.boolean(),
    needsSignIn: z.boolean(),
    identity: z.object({ email: z.string().nullable() }).nullable(),
    environments: z.array(EnvironmentStatusSchema),
  }),
});

/** Resolve the exact shared binding, never an account label or a cached native sign-in. */
async function codexDefinition(serverId: string, providerId: string) {
  const snapshot = await requestInstallationSettings();
  const definitions = snapshot.settings?.providerDefinitions?.filter(
    (item) =>
      item.providerType === "codex" &&
      item.accountSetup?.provider === "codex" &&
      !item.removed &&
      item.bindings[serverId] === providerId,
  );
  if (!definitions || definitions.length !== 1)
    throw new Error("Refresh shared account settings before connecting Codex.");
  return definitions[0]!;
}

/**
 * One Codex sign-in for the installation. Whichever environment the owner opens it from, the
 * coordinator signs the Host account in and delivers it to Dev; there is no environment choice.
 */
export async function codexInstallationRequest(
  serverId: string,
  providerId: string,
  operation: "read" | "start" | "cancel" | "sign-out",
  attempt?: { attemptId: string },
): Promise<{
  login: z.infer<typeof ProviderLoginStateSchema>;
  connection: z.infer<typeof ClaudeSetupConnectionSchema> | undefined;
}> {
  const definition = await codexDefinition(serverId, providerId);
  const result = await requestInstallationOwner(`codex/signin/${operation}`, "", {
    definitionId: definition.id,
    ...attempt,
  });
  if (operation !== "read" && operation !== "sign-out")
    return { login: ProviderLoginStateSchema.parse(result), connection: undefined };
  const { login, connection } = ReadSchema.parse(result);
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
 * Whether the coordinator runs Host-owned Codex sign-in. Its owner routes exist only when the
 * installation enables it, and they refuse an unknown definition with 409. Any other failure
 * keeps the environment's own sign-in.
 */
export async function codexInstallationSignInAvailable(): Promise<boolean> {
  try {
    await requestInstallationOwner("codex/signin/read", "", { definitionId: "availability" });
    return false;
  } catch (error) {
    if (error instanceof OwnerAccessExpired) throw error;
    return error instanceof InstallationRequestFailed && error.status === 409;
  }
}
