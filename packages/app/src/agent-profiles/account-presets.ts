import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";
import { resolveProviderLabel } from "@/utils/provider-definitions";

export interface AccountPresets {
  provider: string;
  label: string;
  rows: AgentProfilePickerRow[];
}

export function accountPresets(input: {
  rows: AgentProfilePickerRow[];
  definitions: readonly AgentProfile[];
  entries: ProviderSnapshotEntry[] | undefined;
  query: string;
}): AccountPresets[] {
  const groups = new Map<string, AccountPresets>();
  for (const row of input.rows) {
    let group = groups.get(row.provider);
    if (!group) {
      group = {
        provider: row.provider,
        label: resolveProviderLabel(row.provider, input.entries),
        rows: [],
      };
      groups.set(row.provider, group);
    }
    group.rows.push(row);
  }
  const query = input.query.trim().toLowerCase();
  const providerRanks = new Map(input.entries?.map((entry, index) => [entry.provider, index]));
  const orderedGroups = [...groups.values()].sort(
    (left, right) =>
      (providerRanks.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
      (providerRanks.get(right.provider) ?? Number.MAX_SAFE_INTEGER),
  );
  return orderedGroups.filter((group) => {
    const models = input.entries?.find((entry) => entry.provider === group.provider)?.models;
    const catalogTerms =
      group.provider === "pi" ? (models?.map((model) => `${model.label} ${model.id}`) ?? []) : [];
    const searchable = [
      group.label,
      ...catalogTerms,
      ...group.rows.map((row) => {
        const definition = input.definitions.find((profile) => profile.id === row.id);
        return `${row.name} ${row.summary} ${definition?.nickname ?? ""}`;
      }),
    ].join(" ");
    return searchable.toLowerCase().includes(query);
  });
}

export function intelligenceLabel(
  profile: AgentProfile | undefined,
  entry: ProviderSnapshotEntry | undefined,
): string {
  const id = profile?.thinkingOptionId;
  if (!id) return "Provider default";
  const model = entry?.models?.find((candidate) => candidate.id === profile.model);
  return (
    model?.thinkingOptions?.find((option) => option.id === id)?.label ??
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}
