import React, { createContext, useContext, type ReactNode } from "react";
import invariant from "tiny-invariant";
import { Portal } from "@gorhom/portal";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import type { OpenInSidePaneSource } from "@/workspace-tabs/open-beside";
import type { PaneHost } from "@/panels/panel-manifest";

export interface PaneContextValue {
  serverId: string;
  workspaceId: string;
  host: PaneHost;
  tabId: string;
  target: WorkspaceTabTarget;
  state?: JsonValue;
  fileNavigationRevision?: number;
  openTab: (target: WorkspaceTabTarget) => void;
  openPreferredTarget: (target: WorkspaceTabTarget, source: OpenInSidePaneSource) => void;
  openTargetToSide?: (target: WorkspaceTabTarget) => void;
  closeCurrentTab: () => void;
  retargetCurrentTab: (target: WorkspaceTabTarget) => void;
  setCurrentTabState: (state: JsonValue) => void;
  openFileInWorkspace: (request: WorkspaceFileOpenRequest) => void;
  openImportSheet: () => void;
}

export interface PaneFocusContextValue {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  isInteractive: boolean;
  focusPane: () => void;
}

const PaneContext = createContext<PaneContextValue | null>(null);
const PaneFocusContext = createContext<PaneFocusContextValue | null>(null);
const noopFocusPane = () => {};

/** Gorhom renders at the host's React location, so carry the source pane explicitly. */
export function PanePortal({ hostName, children }: { hostName: string; children: ReactNode }) {
  const pane = useContext(PaneContext);
  const focus = useContext(PaneFocusContext);
  return (
    <Portal hostName={hostName}>
      <PaneContext.Provider value={pane}>
        <PaneFocusContext.Provider value={focus}>{children}</PaneFocusContext.Provider>
      </PaneContext.Provider>
    </Portal>
  );
}

export function createPaneFocusContextValue(input: {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  onFocusPane?: () => void;
}): PaneFocusContextValue {
  return {
    isWorkspaceFocused: input.isWorkspaceFocused,
    isPaneFocused: input.isPaneFocused,
    isInteractive: input.isWorkspaceFocused && input.isPaneFocused,
    focusPane: input.onFocusPane ?? noopFocusPane,
  };
}

export function PaneProvider({
  value,
  children,
}: {
  value: PaneContextValue;
  children: ReactNode;
}) {
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function PaneFocusProvider({
  value,
  children,
}: {
  value: PaneFocusContextValue;
  children: ReactNode;
}) {
  return <PaneFocusContext.Provider value={value}>{children}</PaneFocusContext.Provider>;
}

export function usePaneContext(): PaneContextValue {
  const value = useContext(PaneContext);
  invariant(value, "PaneContext is required");
  return value;
}

export function usePaneFocus(): PaneFocusContextValue {
  const value = useContext(PaneFocusContext);
  invariant(value, "PaneFocusContext is required");
  return value;
}
