import { PanePortal } from "@/panels/pane-context";
import { createContext, useContext, type ReactNode } from "react";

/** One workspace's supporting views join the focused conversation's card group. */
export const SupportingCardsContext = createContext<{
  agentId: string | null;
  hostName: string | null;
  queueInline?: boolean;
} | null>(null);

export function useWorkspaceCardHost(agentId: string): string | null {
  const value = useContext(SupportingCardsContext);
  return value?.agentId === agentId ? value.hostName : null;
}

/** Desktop queues remain reachable when their details dock is collapsed. */
export function useInlineQueueHost(agentId: string): string | null {
  const value = useContext(SupportingCardsContext);
  return value?.agentId === agentId && value.queueInline && value.hostName
    ? `${value.hostName}:inline-queue`
    : null;
}

export function WorkspaceCardsPortal({
  hostName,
  children,
}: {
  hostName: string | null;
  children: ReactNode;
}) {
  if (!hostName) return null;
  return <PanePortal hostName={hostName}>{children}</PanePortal>;
}
