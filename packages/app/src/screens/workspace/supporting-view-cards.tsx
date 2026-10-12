import { useCardDisclosure } from "@/agent-stream/use-card-disclosure";
import { useCallback, useMemo } from "react";
import { TaskCard, TaskCardHeader, TaskCardAction } from "@/agent-stream/task-card";
import { X } from "lucide-react-native";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { RetainedPanel } from "@/components/retained-panel";
import { WorkspacePaneContent, type WorkspacePaneContentModel } from "./workspace-pane-content";
import { WorkspaceTabPresentationResolver } from "./workspace-tab-presentation";
import { deriveWorkspacePaneState } from "./workspace-pane-state";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import type { SplitPane } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";

export interface SupportingViewCardsProps {
  pane: SplitPane;
  uiTabs: WorkspaceTab[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  onSelectTab: (paneId: string, tabId: string) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

export function SupportingViewCards(props: SupportingViewCardsProps) {
  const state = useMemo(
    () => deriveWorkspacePaneState({ pane: props.pane, tabs: props.uiTabs }),
    [props.pane, props.uiTabs],
  );
  return state.tabs.map(({ descriptor }) => (
    <SupportingViewCard
      key={descriptor.tabId}
      {...props}
      tab={descriptor}
      selected={descriptor.tabId === state.activeTabId}
    />
  ));
}

function SupportingViewCard({
  pane,
  tab,
  selected,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  onSelectTab,
  buildPaneContentModel,
}: SupportingViewCardsProps & {
  tab: WorkspaceTabDescriptor;
  selected: boolean;
}) {
  const [expanded, setExpanded] = useCardDisclosure(tab.kind === "files" ? "files" : "changes");
  const icon = useMemo(
    () => <TaskCardIcon kind={tab.kind === "files" ? "files" : "changes"} />,
    [tab.kind],
  );
  const toggle = useCallback(() => {
    setExpanded((current) => !current);
    if (!expanded) onSelectTab(pane.id, tab.tabId);
  }, [expanded, setExpanded, onSelectTab, pane.id, tab.tabId]);
  const content = useMemo(
    () => buildPaneContentModel({ paneId: pane.id, tab }),
    [buildPaneContentModel, pane.id, tab],
  );
  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => (
        <TaskCard testID={`supporting-card-${tab.kind}`} bodyVisible={expanded} panelHeight={360}>
          <TaskCardHeader>
            <CardDisclosure
              title={presentation.label}
              expanded={expanded}
              onPress={toggle}
              testID={`supporting-card-${tab.kind}-toggle`}
              icon={icon}
              fullWidth={tab.kind === "files" || tab.kind === "changes_tree"}
            />
            {tab.kind !== "files" && tab.kind !== "changes_tree" ? (
              <TaskCardAction
                accessibilityLabel={`Close ${presentation.label}`}
                leftIcon={X}
                onPress={content.paneContextValue.closeCurrentTab}
              />
            ) : null}
          </TaskCardHeader>
          <RetainedPanel active={expanded}>
            <WorkspacePaneContent
              content={content}
              isWorkspaceFocused={isWorkspaceFocused}
              isPaneFocused={expanded && selected}
            />
          </RetainedPanel>
        </TaskCard>
      )}
    </WorkspaceTabPresentationResolver>
  );
}
