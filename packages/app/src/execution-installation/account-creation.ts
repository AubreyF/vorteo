import type {
  InstallationSettingsSnapshot,
  InstallationSettingsUpdate,
} from "@getpaseo/protocol/installation-settings";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";

interface SharedAccountInput {
  creationId: string;
  provider: "codex" | "claude";
  name: string;
  serverIds: readonly string[];
}
interface SharedAccountPorts {
  read(): Promise<InstallationSettingsSnapshot>;
  save(update: InstallationSettingsUpdate): Promise<InstallationSettingsSnapshot>;
}

export async function createSharedAccountDefinition(
  input: SharedAccountInput,
  ports: SharedAccountPorts,
) {
  const snapshot = await ports.read();
  const definitions = snapshot.settings?.providerDefinitions;
  if (!definitions || snapshot.conflicts)
    throw new Error("Resolve shared settings migration before adding an account.");
  const id = `managed/${input.creationId}`;
  const providerId = `${input.provider}-account-${input.creationId}`;
  const existing = definitions.find((definition) => definition.id === id);
  if (existing) {
    if (
      existing.accountSetup?.provider !== input.provider ||
      existing.accountSetup.creationId !== input.creationId ||
      input.serverIds.some((serverId) => existing.bindings[serverId] !== providerId)
    )
      throw new Error("This account request already belongs to a different shared binding.");
    return { providerId, name: existing.policy.label ?? input.name };
  }
  const definition: InstallationProvider = {
    id,
    providerType: input.provider,
    accountSetup: { provider: input.provider, creationId: input.creationId },
    bindings: Object.fromEntries(input.serverIds.map((serverId) => [serverId, providerId])),
    policy: { label: input.name, enabled: true },
  };
  await ports.save({
    expectedRevision: snapshot.revision,
    settings: { providerDefinitions: [...definitions, definition] },
  });
  return { providerId, name: input.name };
}
