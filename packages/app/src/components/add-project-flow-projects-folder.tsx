import { ChevronRight, Folder, FolderGit2, FolderPlus } from "lucide-react-native";
import { useCallback, useMemo, type ComponentType, type RefObject } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import type {
  ProjectsFolderCrumb,
  ProjectsFolderFooter,
  ProjectsFolderRow,
} from "@/add-project-flow/folder-browser";

// Presentation for the Projects folder browser. The list only moves between folders;
// the fixed footer names what its action will do.

interface IconProps {
  icon: ComponentType<{ size?: number; color?: string }>;
  size?: number;
  color?: string;
}

function Icon({ icon: Glyph, size, color }: IconProps) {
  return <Glyph size={size} color={color} />;
}

const MutedIcon = withUnistyles(Icon, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const PRIMARY_SHORTCUT_KEYS = ["mod", "Enter"];

export function ProjectsFolderBreadcrumb({
  crumbs,
  disabled,
  onNavigate,
}: {
  crumbs: ProjectsFolderCrumb[];
  disabled: boolean;
  onNavigate: (crumb: ProjectsFolderCrumb) => void;
}) {
  return (
    <View style={styles.breadcrumb} testID="add-project-flow-breadcrumb">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <View key={crumb.target.path ?? crumb.label} style={styles.crumbGroup}>
            {index > 0 ? <MutedIcon icon={ChevronRight} size={12} /> : null}
            <Crumb
              crumb={crumb}
              current={last}
              disabled={disabled || last}
              index={index}
              onNavigate={onNavigate}
            />
          </View>
        );
      })}
    </View>
  );
}

function Crumb({
  crumb,
  current,
  disabled,
  index,
  onNavigate,
}: {
  crumb: ProjectsFolderCrumb;
  current: boolean;
  disabled: boolean;
  index: number;
  onNavigate: (crumb: ProjectsFolderCrumb) => void;
}) {
  const handlePress = useCallback(() => onNavigate(crumb), [crumb, onNavigate]);
  const style = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.crumb,
      (hovered || pressed) && !disabled && styles.crumbHovered,
    ],
    [disabled],
  );
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={current ? `${crumb.label}, current folder` : `Go to ${crumb.label}`}
      testID={`add-project-flow-crumb-${index}`}
    >
      <Text style={current ? styles.crumbCurrent : styles.crumbText} numberOfLines={1}>
        {crumb.label}
      </Text>
    </Pressable>
  );
}

export function ProjectsFolderRowView({
  row,
  active,
  disabled,
  onSelect,
  onAdd,
}: {
  row: ProjectsFolderRow;
  active: boolean;
  disabled: boolean;
  onSelect: (row: ProjectsFolderRow) => void;
  onAdd: (row: ProjectsFolderRow) => void;
}) {
  const handleSelect = useCallback(() => onSelect(row), [onSelect, row]);
  const handleAdd = useCallback(() => onAdd(row), [onAdd, row]);
  const accessibilityState = useMemo(() => ({ disabled, selected: active }), [active, disabled]);
  const style = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (active || hovered || pressed) && styles.rowActive,
    ],
    [active],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        row.action === "open-project" ? `Open project ${row.title}` : `Open folder ${row.title}`
      }
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={handleSelect}
      style={style}
      testID={`add-project-flow-folder-${encodeURIComponent(row.title)}`}
    >
      <View style={styles.iconSlot}>
        <MutedIcon icon={row.git ? FolderGit2 : Folder} size={16} />
      </View>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {row.title}
      </Text>
      {row.projectId ? (
        <View style={styles.badge} testID="add-project-flow-project-badge">
          <Text style={styles.badgeText}>Project</Text>
        </View>
      ) : null}
      {row.canAdd ? (
        <Button
          size="xs"
          variant="outline"
          onPress={handleAdd}
          disabled={disabled}
          accessibilityLabel={`Add ${row.title} as project`}
          testID={`add-project-flow-add-row-${encodeURIComponent(row.title)}`}
        >
          Add
        </Button>
      ) : null}
      <MutedIcon icon={ChevronRight} size={14} />
    </Pressable>
  );
}

export function NewFolderNameRow({
  inputRef,
  initialValue,
  preview,
  disabled,
  onChange,
  onSubmit,
  onKeyPress,
}: {
  inputRef: RefObject<EditingTextInputHandle | null>;
  initialValue: string;
  preview: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
}) {
  return (
    <View style={styles.nameRow} testID="add-project-flow-new-folder-row">
      <View style={styles.iconSlot}>
        <MutedIcon icon={FolderPlus} size={16} />
      </View>
      <View style={styles.nameText}>
        <ThemedTextInput
          ref={inputRef}
          initialValue={initialValue}
          onChangeText={onChange}
          onSubmitEditing={onSubmit}
          onKeyPress={onKeyPress}
          placeholder="New folder name"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          returnKeyType="done"
          style={styles.nameInput}
          testID="add-project-flow-new-folder-name"
        />
        {preview ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {preview}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function ProjectsFolderFooterBar({
  footer,
  naming,
  busy,
  onPrimary,
  onNewFolder,
}: {
  footer: ProjectsFolderFooter;
  naming: boolean;
  busy: boolean;
  onPrimary: () => void;
  onNewFolder: () => void;
}) {
  const shortcut = useMemo(
    () => <Shortcut keys={PRIMARY_SHORTCUT_KEYS} textStyle={styles.shortcutText} />,
    [],
  );
  return (
    <View style={styles.footer} testID="add-project-flow-action-footer">
      <View style={styles.footerText}>
        <Text style={styles.footerDetail} numberOfLines={1} testID="add-project-flow-target">
          {footer.reason ?? footer.detail}
        </Text>
      </View>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={FolderPlus}
        onPress={onNewFolder}
        disabled={busy || naming || !footer.canCreateFolder}
        testID="add-project-flow-new-folder"
      >
        New folder
      </Button>
      <Button
        size="sm"
        variant="default"
        onPress={onPrimary}
        disabled={busy || footer.disabled}
        trailing={shortcut}
        testID="add-project-flow-primary"
      >
        {footer.label}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  breadcrumb: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    minHeight: 32,
  },
  crumbGroup: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
  },
  crumb: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  crumbHovered: { backgroundColor: theme.colors.surface1 },
  crumbText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  crumbCurrent: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
  rowActive: { backgroundColor: theme.colors.surface1 },
  iconSlot: { width: 18, alignItems: "center" },
  rowTitle: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  rowSubtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, marginTop: 2 },
  badge: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  badgeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  nameText: { flex: 1, minWidth: 0 },
  nameInput: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as object,
  footer: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerText: { flex: 1, minWidth: 0 },
  footerDetail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  shortcutText: { color: theme.colors.accentForeground, fontSize: theme.fontSize.sm },
}));
