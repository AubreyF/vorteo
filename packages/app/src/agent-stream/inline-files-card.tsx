import { useCallback, useMemo } from "react";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { RetainedPanel } from "@/components/retained-panel";
import { usePaneContext } from "@/panels/pane-context";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspace } from "@/stores/session-store-hooks";
import { TaskCard, TaskCardHeader } from "./task-card";
import { TaskCardIcon } from "./task-card-icon";
import { CardDisclosure } from "./card-disclosure";
import { useCardDisclosure } from "./use-card-disclosure";

/** Mobile workspace files live beside the conversation's other inline cards. */
export function InlineFilesCard({
  serverId,
  workspaceId,
  cwd,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string;
}) {
  const [expanded, setExpanded] = useCardDisclosure("files");
  const workspace = useWorkspace(serverId, workspaceId);
  const { openFileInWorkspace } = usePaneContext();
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  const toggle = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const openFile = useCallback(
    (path: string) => openFileInWorkspace({ location: { path }, disposition: "main" }),
    [openFileInWorkspace],
  );
  const icon = useMemo(() => <TaskCardIcon kind="files" />, []);
  return (
    <TaskCard bodyVisible={expanded} panelHeight={360} testID="supporting-card-files">
      <TaskCardHeader>
        <CardDisclosure
          title="Files"
          expanded={expanded}
          onPress={toggle}
          icon={icon}
          fullWidth
          testID="supporting-card-files-toggle"
        />
      </TaskCardHeader>
      <RetainedPanel active={expanded}>
        <FileExplorerPane
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspace?.workspaceDirectory || cwd}
          onOpenFile={openFile}
          onAddToChat={canAddToChat ? addFile : undefined}
        />
      </RetainedPanel>
    </TaskCard>
  );
}
