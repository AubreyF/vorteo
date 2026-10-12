import { usePanelStore } from "@/stores/panel-store";
import { create } from "zustand";
import type { WorkspaceTabTarget } from "./model";

interface SupportingCardRequests {
  requests: Record<string, { kind: WorkspaceTabTarget["kind"]; revision: number }>;
}

// Ephemeral navigation intent, not a saved layout. A repeated command must reveal
// a folded card even when its tab was already the selected supporting view.
export const useSupportingCardRequests = create<SupportingCardRequests>(() => ({ requests: {} }));

export function requestSupportingCard(workspaceKey: string, kind: WorkspaceTabTarget["kind"]) {
  usePanelStore.getState().setSupportingCardExpanded(kind === "files" ? "files" : "changes", true);
  useSupportingCardRequests.setState((state) => ({
    requests: {
      ...state.requests,
      [workspaceKey]: { kind, revision: (state.requests[workspaceKey]?.revision ?? 0) + 1 },
    },
  }));
}
