import { useCallback, useState } from "react";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceClipboardActions } from "@/hooks/use-workspace-clipboard-actions";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useWorkspaceReadState } from "@/hooks/use-workspace-read-state";

export function useWorkspaceMenuActions({
  workspace,
  selected,
  canPin,
  onToggleWorkspacePin,
}: {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  const toast = useToast();
  const [isHidingWorkspace, setIsHidingWorkspace] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const isArchiving = workspace.archivingAt !== null || isHidingWorkspace;
  const redirectAfterArchive = useCallback(() => {
    redirectIfArchivingActiveWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      activeWorkspaceSelection: selected
        ? { serverId: workspace.serverId, workspaceId: workspace.workspaceId }
        : null,
    });
  }, [selected, workspace]);

  const archiveController = useWorkspaceArchive({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    workspaceKind: workspace.workspaceKind,
    name: workspace.name,
    ...toWorktreeArchiveRisk(workspace),
    onArchiveStarted: redirectAfterArchive,
    onSetHiding: setIsHidingWorkspace,
  });

  const handleArchive = useCallback(() => {
    if (isArchiving) {
      return;
    }
    archiveController.archive();
  }, [archiveController, isArchiving]);

  const clipboard = useWorkspaceClipboardActions();
  const handleCopyPath = useCallback(() => {
    clipboard.copyPath(workspace);
  }, [clipboard, workspace]);

  const handleCopyBranchName = useCallback(() => {
    clipboard.copyBranchName(workspace);
  }, [clipboard, workspace]);

  const handleOpenRename = useCallback(() => {
    setIsRenameOpen(true);
  }, []);

  const handleCloseRename = useCallback(() => {
    setIsRenameOpen(false);
  }, []);

  const isPinned = workspace.pinnedAt != null;
  const handleTogglePin = useCallback(() => {
    onToggleWorkspacePin(workspace);
  }, [onToggleWorkspacePin, workspace]);
  const onTogglePin = canPin ? handleTogglePin : undefined;

  const archiveShortcutKeys = useShortcutKeys("archive-workspace");
  const { hasClearableAttention, canMarkUnread, clearAttention, markUnread } =
    useWorkspaceReadState({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
    });
  const handleMarkAsRead = useCallback(() => {
    void clearAttention().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as read");
    });
  }, [clearAttention, toast]);
  const handleMarkAsUnread = useCallback(() => {
    void markUnread().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as unread");
    });
  }, [markUnread, toast]);

  return {
    isArchiving,
    archiveProtected: archiveController.archiveProtected,
    isRenameOpen,
    handleArchive,
    handleCopyPath,
    handleCopyBranchName,
    handleOpenRename,
    handleCloseRename,
    isPinned,
    onTogglePin,
    archiveShortcutKeys,
    hasClearableAttention,
    canMarkUnread,
    handleMarkAsRead,
    handleMarkAsUnread,
  };
}
