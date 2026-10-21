import { PanePortal } from "@/panels/pane-context";
import { createContext, useContext, type ReactNode } from "react";

/** One workspace's supporting views join the focused conversation's card group. */
export const SupportingCardsContext = createContext<{
  agentId: string | null;
  hostName: string | null;
  cardsInline?: boolean;
} | null>(null);

export function useWorkspaceCardHost(agentId: string): string | null {
  const value = useContext(SupportingCardsContext);
  return value?.agentId === agentId ? value.hostName : null;
}

/** All details remain reachable when their sidebar is closed. */
export function useInlineCardsHost(agentId: string): string | null {
  const value = useContext(SupportingCardsContext);
  return value?.agentId === agentId && value.cardsInline && value.hostName
    ? `${value.hostName}:inline-cards`
    : null;
}

/**
 * Draws a conversation's cards only while it is the focused one. Portal content renders at the
 * host, so this reads the host's live focus. The portal transport mutates its state in place and
 * can resurrect an entry after its source unmounts; the check keeps such an entry from showing
 * another tab's cards.
 */
export function FocusedAgentCards({ agentId, children }: { agentId: string; children: ReactNode }) {
  const value = useContext(SupportingCardsContext);
  return value?.agentId === agentId ? children : null;
}

export function WorkspaceCardsPortal({
  hostName,
  agentId,
  children,
}: {
  hostName: string | null;
  agentId: string;
  children: ReactNode;
}) {
  if (!hostName) return null;
  return (
    <PanePortal hostName={hostName}>
      <FocusedAgentCards agentId={agentId}>{children}</FocusedAgentCards>
    </PanePortal>
  );
}
