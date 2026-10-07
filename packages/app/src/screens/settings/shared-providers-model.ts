import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";

export interface ProviderAccount {
  id: string;
  name: string;
  enabled: boolean;
  definitions: InstallationProvider[];
}
export interface ProviderFamily {
  id: string;
  name: string;
  enabled: boolean;
  accounts: ProviderAccount[];
}

export function groupInstallationProviders(
  definitions: readonly InstallationProvider[],
  visibility: "active" | "removed" = "active",
): ProviderFamily[] {
  const families = new Map<string, ProviderFamily>();
  for (const definition of definitions) {
    if ((definition.removed === true) !== (visibility === "removed")) continue;
    const type = definition.providerType;
    const manifest = AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === type);
    let family = families.get(type);
    if (!family) {
      family = { id: type, name: manifest?.label ?? type, enabled: false, accounts: [] };
      families.set(type, family);
    }
    const enabled = definition.policy.enabled ?? manifest?.enabledByDefault ?? true;
    family.enabled ||= enabled;
    const isDefault =
      !definition.accountId && Object.values(definition.bindings).every((id) => id === type);
    const id = isDefault ? `default/${type}` : definition.id;
    const account = family.accounts.find((entry) => entry.id === id);
    if (account) {
      account.definitions.push(definition);
      account.enabled ||= enabled;
    } else
      family.accounts.push({
        id,
        name: definition.policy.label ?? "Default connection",
        enabled,
        definitions: [definition],
      });
  }
  return [...families.values()];
}
