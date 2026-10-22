import { useCallback, useMemo, useState, type Ref } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react-native";
import type { SidebarFolderScope } from "@getpaseo/protocol/sidebar-state";
import { sidebarFolderEntry } from "@getpaseo/protocol/sidebar-folders";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { SidebarCountBadge } from "@/components/sidebar/sidebar-count-badge";
import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useVortonTouch } from "@/vorton-touch";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import {
  toggleSidebarFolderCollapsed,
  useCreateSidebarFolderAction,
  useMoveToSidebarFolderAction,
  useSidebarFolderDialog,
} from "./actions";
import { useRemoveSidebarFolder } from "./dialogs";
import { SidebarFolderDropTarget } from "./drop-context";
import type { SidebarFolderRow as SidebarFolderRowModel } from "./tree";

/** Each nesting level steps in by one icon slot, like workspaces under their project. */
export const SIDEBAR_FOLDER_INDENT = 16;

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedFolder = withUnistyles(Folder);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedFolderInput = withUnistyles(FolderInput);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const newFolderIcon = <ThemedFolderPlus size={14} uniProps={mutedColorMapping} />;
const moveIcon = <ThemedFolderInput size={14} uniProps={mutedColorMapping} />;
const renameIcon = <ThemedPencil size={14} uniProps={mutedColorMapping} />;
const deleteIcon = <ThemedTrash2 size={14} uniProps={mutedColorMapping} />;

/** Project folders sit among workspace rows, so their icon shares the workspace status slot. */
const PROJECT_FOLDER_INSET = 20;

export function sidebarDepthStyle(depth: number, inset = 0) {
  return inlineUnistylesStyle({ paddingLeft: inset + depth * SIDEBAR_FOLDER_INDENT });
}

function renderKebabIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical size={14} uniProps={hovered ? foregroundColorMapping : mutedColorMapping} />
  );
}

type MenuSurface = "context" | "dropdown";

function FolderMenuItems({
  surface,
  row,
  scope,
}: {
  surface: MenuSurface;
  row: SidebarFolderRowModel;
  scope: SidebarFolderScope;
}) {
  const { t } = useTranslation();
  const { folder } = row;
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const createInside = useCreateSidebarFolderAction(scope, folder.id);
  const move = useMoveToSidebarFolderAction({
    scope,
    entry: sidebarFolderEntry(folder.id),
    title: folder.name,
  });
  const remove = useRemoveSidebarFolder();
  const rename = useCallback(
    () => useSidebarFolderDialog.getState().open({ kind: "rename", folderId: folder.id }),
    [folder.id],
  );
  const removeFolder = useCallback(() => remove(folder.id, folder.name), [remove, folder]);
  return (
    <>
      {createInside ? (
        <Item
          leading={newFolderIcon}
          onSelect={createInside}
          testID={`sidebar-folder-menu-new-${folder.id}`}
        >
          {t("sidebar.folders.actions.newSubfolder")}
        </Item>
      ) : null}
      <Item
        leading={renameIcon}
        onSelect={rename}
        testID={`sidebar-folder-menu-rename-${folder.id}`}
      >
        {t("sidebar.folders.actions.rename")}
      </Item>
      {move ? (
        <Item leading={moveIcon} onSelect={move} testID={`sidebar-folder-menu-move-${folder.id}`}>
          {t("sidebar.folders.actions.moveToFolder")}
        </Item>
      ) : null}
      <Item
        leading={deleteIcon}
        onSelect={removeFolder}
        testID={`sidebar-folder-menu-delete-${folder.id}`}
      >
        {t("sidebar.folders.actions.delete")}
      </Item>
    </>
  );
}

/**
 * A folder heading inside a sortable sidebar list. Pressing it folds the folder; dragging it
 * moves the folder with its contents; dropping a row onto it (web) moves the row inside.
 */
export function SidebarFolderRow({
  row,
  scope,
  drag,
  isDragging,
  dragHandleProps,
}: {
  row: SidebarFolderRowModel;
  scope: SidebarFolderScope;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const { t } = useTranslation();
  const density = useSidebarRowDensity();
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const interaction = useLongPressDragInteraction({ drag, menuController: null });
  const { folder, collapsed, depth, itemCount } = row;
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};
  const toggle = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    toggleSidebarFolderCollapsed(folder.id);
  }, [folder.id, interaction.didLongPressRef]);
  const handlePointerEnter = useCallback(() => {
    if (!touch) setIsHovered(true);
  }, [touch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const rowStyle = useMemo(
    () => [
      styles.row,
      density,
      sidebarDepthStyle(depth, scope.kind === "project" ? PROJECT_FOLDER_INSET : 0),
      (isHovered || contextMenuOpen) && styles.rowHovered,
      isDragging && styles.rowDragging,
    ],
    [scope.kind, density, depth, isHovered, contextMenuOpen, isDragging],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const kebabStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.kebab,
      hovered && styles.kebabHovered,
    ],
    [],
  );
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  const showActions = isHovered || menuOpen || touch || compact || isNative;
  const countLabel = String(itemCount);

  return (
    <SidebarFolderDropTarget folderId={folder.id} scope={scope}>
      <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
        <View
          {...dragAttributes}
          {...dragHandleProps?.listeners}
          ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
          style={rowStyle}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          <ContextMenuTrigger
            enabledOnMobile={false}
            accessibilityRole="button"
            accessibilityLabel={folder.name}
            accessibilityState={accessibilityState}
            style={styles.main}
            onPressIn={interaction.handlePressIn}
            onTouchMove={interaction.handleTouchMove}
            onPressOut={interaction.handlePressOut}
            onPress={toggle}
            testID={`sidebar-folder-row-${folder.id}`}
          >
            <View style={styles.chevronSlot}>
              <Chevron size={12} uniProps={mutedColorMapping} />
            </View>
            <ThemedFolder size={14} uniProps={mutedColorMapping} />
            <Text style={styles.title} numberOfLines={1}>
              {folder.name}
            </Text>
            {collapsed ? (
              <SidebarCountBadge
                label={countLabel}
                accessibilityLabel={`${folder.name}: ${countLabel}`}
                testID={`sidebar-folder-count-${folder.id}`}
              />
            ) : null}
          </ContextMenuTrigger>
          <View
            style={showActions ? undefined : styles.hidden}
            pointerEvents={showActions ? "auto" : "none"}
          >
            <DropdownMenu compactMode="sheet" open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                hitSlop={8}
                style={kebabStyle}
                accessibilityRole="button"
                accessibilityLabel={t("sidebar.folders.actions.menu")}
                testID={`sidebar-folder-kebab-${folder.id}`}
              >
                {renderKebabIcon}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                width={220}
                sheetTitle={t("sidebar.folders.actions.menu")}
              >
                <FolderMenuItems surface="dropdown" row={row} scope={scope} />
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        </View>
        <ContextMenuContent
          align="start"
          width={220}
          testID={`sidebar-folder-context-${folder.id}`}
        >
          <FolderMenuItems surface="context" row={row} scope={scope} />
        </ContextMenuContent>
      </ContextMenu>
    </SidebarFolderDropTarget>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    position: "relative",
    minHeight: 36,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  rowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    zIndex: 3,
    ...theme.shadow.md,
  },
  main: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
  },
  chevronSlot: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  hidden: { opacity: 0 },
  kebab: { padding: 2, borderRadius: 4 },
  kebabHovered: { backgroundColor: theme.colors.surface2 },
}));
