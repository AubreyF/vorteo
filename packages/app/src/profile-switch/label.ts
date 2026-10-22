import type { ProfileSwitchEndpoint, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveProviderLabel } from "@/utils/provider-definitions";

/** "Claude 1 · claude-opus-4-7", using the account label the profile picker shows. */
export function profileSwitchEndpointLabel(
  endpoint: ProfileSwitchEndpoint,
  entries: ProviderSnapshotEntry[] | undefined,
): string {
  const account = resolveProviderLabel(endpoint.provider, entries);
  return endpoint.model ? `${account} · ${endpoint.model}` : account;
}
