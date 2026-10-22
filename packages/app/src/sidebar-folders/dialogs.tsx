import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { ActionFooter } from "@/components/ui/action-footer";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  createSidebarFolder,
  moveSidebarEntry,
  removeSidebarFolder,
  renameSidebarFolder,
  useSidebarFolderDialog,
} from "./actions";
import { useSidebarFolderStore } from "./store";
import { listSidebarFolderDestinations, sidebarEntryParent } from "./tree";

const TOP_LEVEL = "";
const FOLDER_NAME_MAX_LENGTH = 200;

export function SidebarFolderDialogHost() {
  const request = useSidebarFolderDialog((state) => state.request);
  if (!request) return null;
  switch (request.kind) {
    case "create":
      return <CreateFolderModal scope={request.scope} parentId={request.parentId} />;
    case "rename":
      return <RenameFolderModal folderId={request.folderId} />;
    case "move":
      return (
        <MoveToFolderModal
          key={request.entry}
          scope={request.scope}
          entry={request.entry}
          title={request.title}
        />
      );
  }
}

function CreateFolderModal({
  scope,
  parentId,
}: {
  scope: SidebarFolderScope;
  parentId: string | null;
}) {
  const { t } = useTranslation();
  const close = useSidebarFolderDialog((state) => state.close);
  const submit = useCallback(
    (name: string) => createSidebarFolder({ scope, parentId, name }),
    [scope, parentId],
  );
  return (
    <AdaptiveRenameModal
      visible
      title={t("sidebar.folders.dialogs.createTitle")}
      initialValue=""
      placeholder={t("sidebar.folders.dialogs.namePlaceholder")}
      submitLabel={t("sidebar.folders.dialogs.create")}
      maxLength={FOLDER_NAME_MAX_LENGTH}
      onClose={close}
      onSubmit={submit}
      testID="sidebar-folder-create-modal"
    />
  );
}

function RenameFolderModal({ folderId }: { folderId: string }) {
  const { t } = useTranslation();
  const close = useSidebarFolderDialog((state) => state.close);
  const name = useSidebarFolderStore((state) => state.sidebarFolders[folderId]?.name ?? "");
  const submit = useCallback((value: string) => renameSidebarFolder(folderId, value), [folderId]);
  return (
    <AdaptiveRenameModal
      visible
      title={t("sidebar.folders.dialogs.renameTitle")}
      initialValue={name}
      placeholder={t("sidebar.folders.dialogs.namePlaceholder")}
      submitLabel={t("sidebar.folders.dialogs.rename")}
      maxLength={FOLDER_NAME_MAX_LENGTH}
      onClose={close}
      onSubmit={submit}
      testID="sidebar-folder-rename-modal"
    />
  );
}

function MoveToFolderModal({
  scope,
  entry,
  title,
}: {
  scope: SidebarFolderScope;
  entry: string;
  title: string;
}) {
  const { t } = useTranslation();
  const close = useSidebarFolderDialog((state) => state.close);
  const folderState = useSidebarFolderStore();
  const movingFolderId = entry.startsWith("folder:") ? entry.slice("folder:".length) : null;
  const currentParent = sidebarEntryParent({ state: folderState, scope, entry });
  const [selected, setSelected] = useState(currentParent ?? TOP_LEVEL);
  const options = useMemo(() => {
    const names = new Map<string, string>();
    const destinations = listSidebarFolderDestinations({
      state: folderState,
      scope,
      movingFolderId,
    }).map(({ folder }) => {
      const parentPath = folder.parentId === null ? null : names.get(folder.parentId);
      const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
      names.set(folder.id, path);
      return { id: folder.id, value: folder.id, label: path };
    });
    const topLevel = t("sidebar.folders.dialogs.topLevel");
    return [{ id: TOP_LEVEL, value: TOP_LEVEL, label: topLevel }, ...destinations];
  }, [folderState, movingFolderId, scope, t]);
  const selectedDisplay = useMemo(
    () => ({ label: options.find((option) => option.value === selected)?.label ?? "" }),
    [options, selected],
  );
  const submit = useCallback(() => {
    moveSidebarEntry({ scope, entry, targetFolderId: selected === TOP_LEVEL ? null : selected });
    close();
  }, [close, entry, scope, selected]);
  const header = useMemo(
    () => ({ title: t("sidebar.folders.dialogs.moveTitle", { name: title }) }),
    [t, title],
  );
  const footer = useMemo(
    () => (
      <ActionFooter style={styles.actions}>
        <Button variant="ghost" onPress={close}>
          {t("sidebar.folders.dialogs.cancel")}
        </Button>
        <Button
          onPress={submit}
          disabled={selected === (currentParent ?? TOP_LEVEL)}
          testID="sidebar-folder-move-confirm"
        >
          {t("sidebar.folders.dialogs.move")}
        </Button>
      </ActionFooter>
    ),
    [close, currentParent, selected, submit, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      footer={footer}
      onClose={close}
      testID="sidebar-folder-move-modal"
    >
      <View style={styles.body}>
        <SelectField
          label={t("sidebar.folders.dialogs.destination")}
          value={selected}
          selectedDisplay={selectedDisplay}
          options={options}
          onChange={setSelected}
          searchable
          size="md"
          placeholder={t("sidebar.folders.dialogs.destination")}
          emptyText={t("sidebar.folders.dialogs.topLevel")}
          triggerTestID="sidebar-folder-move-destination"
        />
      </View>
    </AdaptiveModalSheet>
  );
}

/** Deleting a folder never archives anything: its contents move up one level. */
export function useRemoveSidebarFolder(): (folderId: string, folderName: string) => void {
  const { t } = useTranslation();
  return useCallback(
    (folderId: string, folderName: string) => {
      void confirmDialog({
        title: t("sidebar.folders.confirmations.deleteTitle"),
        message: t("sidebar.folders.confirmations.deleteMessage", { folderName }),
        confirmLabel: t("sidebar.folders.confirmations.deleteConfirm"),
        cancelLabel: t("sidebar.folders.dialogs.cancel"),
        destructive: true,
      }).then((confirmed) => {
        if (confirmed) removeSidebarFolder(folderId);
        return undefined;
      });
    },
    [t],
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
