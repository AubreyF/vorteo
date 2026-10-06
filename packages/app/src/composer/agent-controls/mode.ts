import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { AgentMode, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export function resolveNextAgentModeId({
  modeOptions,
  selectedMode,
}: {
  modeOptions: readonly AgentMode[];
  selectedMode: string | null | undefined;
}): string | null {
  if (modeOptions.length < 2) return null;

  const selectedIndex = modeOptions.findIndex((mode) => mode.id === selectedMode);
  const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const nextIndex = (currentIndex + 1) % modeOptions.length;
  return modeOptions[nextIndex]?.id ?? null;
}

export function resolveAgentControlsMode(agentControls?: DraftAgentControlsProps) {
  return agentControls ? "draft" : "ready";
}

export function resolveLiveAgentModes(input: {
  availableModes: AgentMode[];
  supportsDynamicModes: boolean;
  provider: string;
  snapshotEntries: ProviderSnapshotEntry[] | undefined;
}): AgentMode[] {
  if (input.availableModes.length > 0 || input.supportsDynamicModes) {
    return input.availableModes;
  }
  // Cached and stored agents omit session modes. Fixed-mode providers can use
  // the host's catalog until the session snapshot arrives; dynamic modes cannot.
  const entry = input.snapshotEntries?.find((candidate) => candidate.provider === input.provider);
  if (entry?.status !== "ready" || !entry.enabled) return input.availableModes;
  return entry.modes ?? input.availableModes;
}
