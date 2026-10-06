import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderUsageView } from "@/provider-usage/types";
import { quotaReading } from "@/provider-usage/quota-reading";
import { presetNickname } from "./nickname";

interface SelectionInput {
  selectedProfileId?: string;
  selectedProfileName?: string;
  currentProvider?: string;
  selected?: { name: string; provider: string };
  definitions: AgentProfile[] | null;
  compactName?: boolean;
  view: ProviderUsageView;
  now: number;
}
export function selectedPresetPresentation(input: SelectionInput) {
  const emptyLabel = "Choose profile";
  const fullName = input.selectedProfileName ?? input.selected?.name ?? emptyLabel;
  const definition = input.definitions?.find((row) => row.id === input.selectedProfileId);
  const triggerLabel =
    input.compactName !== false && input.selectedProfileId
      ? presetNickname({ name: fullName, nickname: definition?.nickname })
      : fullName;
  const providerId = input.currentProvider ?? input.selected?.provider ?? definition?.provider;
  const reading = quotaReading(input.view, providerId, input.now);
  const { remaining, statusLabel } = reading;
  const showWarning = Boolean(input.selectedProfileId) && Boolean(reading.authRecovery);
  const showRing = Boolean(input.selectedProfileId) && Boolean(reading.window);
  let accessibilityLabel = input.selectedProfileId
    ? `Profile (${fullName}, ${triggerLabel})`
    : emptyLabel;
  if (showWarning) accessibilityLabel += ", account disconnected, open profiles to reconnect";
  if (showRing) accessibilityLabel += usageAccessibilityLabel(remaining, statusLabel);
  return { triggerLabel, showWarning, showRing, remaining, statusLabel, accessibilityLabel };
}

function usageAccessibilityLabel(remaining: number | null, statusLabel: string | null) {
  const remainingLabel =
    remaining === null ? ", usage unavailable" : `, ${Math.round(remaining)} percent remaining`;
  return remainingLabel + (statusLabel ? `, ${statusLabel}` : "");
}
