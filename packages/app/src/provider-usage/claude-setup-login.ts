import { z } from "zod";
import { ProviderLoginStateSchema } from "@getpaseo/protocol/provider-login";
import { requestInstallationOwner } from "@/execution-installation/client";
import { requestInstallationSettings } from "@/execution-installation/settings";

export const ClaudeSetupConnectionSchema = z.strictObject({
  connected: z.boolean(),
  environments: z.array(
    z.strictObject({
      serverId: z.string(),
      status: z.enum(["ready", "pending", "excluded", "disconnected", "disconnecting"]),
    }),
  ),
});
const ReadSchema = z.strictObject({
  login: ProviderLoginStateSchema,
  connection: ClaudeSetupConnectionSchema,
});

/** Resolve exact shared bindings, never account labels or cached native-login identities. */
export async function claudeSetupRequest(
  serverId: string,
  providerId: string,
  operation: "read" | "start" | "submit" | "cancel" | "sign-out",
  attempt?: { attemptId: string; code?: string },
) {
  const snapshot = await requestInstallationSettings();
  const definitions = snapshot.settings?.providerDefinitions?.filter(
    (item) =>
      item.providerType === "claude" && !item.removed && item.bindings[serverId] === providerId,
  );
  if (!definitions || definitions.length !== 1)
    throw new Error("Refresh shared account settings before connecting Claude.");
  const result = await requestInstallationOwner(`claude/setup-token/${operation}`, "", {
    definitionId: definitions[0]!.id,
    ...attempt,
  });
  if (operation === "read" || operation === "sign-out") return ReadSchema.parse(result);
  return { login: ProviderLoginStateSchema.parse(result), connection: undefined };
}
