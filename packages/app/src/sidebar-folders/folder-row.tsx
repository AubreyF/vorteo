import { useCallback, useMemo, useState, type Ref } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  ChevronsRight,
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
import { sidebarIndentStyle } from "@/components/sidebar/indent";
import { sidebarContainerRowStyles } from "@/components/sidebar/container-row";
import {
  SidebarFolderIcon,
  SidebarLeadingSlot,
  type SidebarDisclosure,
} from "@/components/sidebar/leading-slot";
import type { Theme } from "@/styles/theme";
import {
  toggleSidebarFolderCollapsed,
  useCreateSidebarFolderAction,
  useMoveToSidebarFolderAction,
  useSidebarFolderDialog,
} from "./actions";
import { useRemoveSidebarFolder } from "./dialogs";
import { SidebarFocusButton } from "@/sidebar-focus/focus-button";
import { useSidebarRowFocus } from "@/sidebar-focus/context";
import type { SidebarFocusTarget } from "@/sidebar-focus/model";
import type { SidebarFolderRow as SidebarFolderRowModel } from "./tree";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedFolderInput = withUnistyles(FolderInput);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedChevronsRight = withUnistyles(ChevronsRight);
const newFolderIcon = <ThemedFolderPlus size={14} uniProps={mutedColorMapping} />;
const moveIcon = <ThemedFolderInput size={14} uniProps={mutedColorMapping} />;
const renameIcon = <ThemedPencil size={14} uniProps={mutedColorMapping} />;
const deleteIcon = <ThemedTrash2 size={14} uniProps={mutedColorMapping} />;
const focusIcon = <ThemedChevronsRight size={14} uniProps={mutedColorMapping} />;

function renderKebabIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical size={14} uniProps={hovered ? foregroundColorMapping : mutedColorMapping} />
  );
}

type MenuSurface = "context" | "dropdown";

function folderChevron(isFocusRoot: boolean, collapsed: boolean): SidebarDisclosure {
  if (isFocusRoot) return null;
  return collapsed ? "expand" : "collapse";
}

function FolderMenuItems({
  surface,
  row,
  scope,
  onFocus,
}: {
  surface: MenuSurface;
  row: SidebarFolderRowModel;
  scope: SidebarFolderScope;
  /** Present only where rows cannot be hovered, so touch layouts can still focus. */
  onFocus: (() => void) | null;
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
      {onFocus ? (
        <Item
          leading={focusIcon}
          onSelect={onFocus}
          testID={`sidebar-folder-menu-focus-${folder.id}`}
        >
          {t("sidebar.focus.menuItem")}
        </Item>
      ) : null}
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
  level,
  drag,
  isDragging,
  dragHandleProps,
}: {
  row: SidebarFolderRowModel;
  scope: SidebarFolderScope;
  /** Hierarchy level, which sets the indent; see `sidebarIndent`. */
  level: number;
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
  const { folder, collapsed, itemCount } = row;
  const focusTarget = useMemo<SidebarFocusTarget>(
    () => ({ kind: "folder", folderId: folder.id }),
    [folder.id],
  );
  const rowFocus = useSidebarRowFocus({ target: focusTarget, isHovered });
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
    if (rowFocus.isRoot) return;
    toggleSidebarFolderCollapsed(folder.id);
  }, [folder.id, interaction.didLongPressRef, rowFocus.isRoot]);
  const handlePointerEnter = useCallback(() => {
    if (!touch) setIsHovered(true);
  }, [touch]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const rowStyle = useMemo(
    () => [
      sidebarContainerRowStyles.row,
      density,
      sidebarIndentStyle(level),
      (isHovered || contextMenuOpen) && sidebarContainerRowStyles.rowHovered,
      isDragging && styles.rowDragging,
    ],
    [density, level, isHovered, contextMenuOpen, isDragging],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const kebabStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.kebab,
      hovered && styles.kebabHovered,
    ],
    [],
  );
  const showActions = isHovered || menuOpen || touch || compact || isNative;
  const countLabel = String(itemCount);

  return (
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
          style={sidebarContainerRowStyles.main}
          onPressIn={interaction.handlePressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={interaction.handlePressOut}
          onPress={toggle}
          testID={`sidebar-folder-row-${folder.id}`}
        >
          <SidebarLeadingSlot
            chevron={folderChevron(rowFocus.isRoot, collapsed)}
            revealChevron={isHovered || touch}
            testID={`sidebar-folder-leading-${folder.id}`}
          >
            <SidebarFolderIcon />
          </SidebarLeadingSlot>
          <Text style={sidebarContainerRowStyles.title} numberOfLines={1}>
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
        {rowFocus.buttonAction ? (
          <SidebarFocusButton
            name={folder.name}
            onPress={rowFocus.buttonAction}
            testID={`sidebar-folder-focus-${folder.id}`}
          />
        ) : null}
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
              <FolderMenuItems
                surface="dropdown"
                row={row}
                scope={scope}
                onFocus={rowFocus.menuAction}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
      <ContextMenuContent align="start" width={220} testID={`sidebar-folder-context-${folder.id}`}>
        <FolderMenuItems surface="context" row={row} scope={scope} onFocus={rowFocus.menuAction} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    zIndex: 3,
    ...theme.shadow.md,
  },
  hidden: { opacity: 0 },
  kebab: { padding: 2, borderRadius: 4 },
  kebabHovered: { backgroundColor: theme.colors.surface2 },
}));
