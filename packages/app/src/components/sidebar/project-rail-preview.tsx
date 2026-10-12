import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useBottomSheetModalInternal } from "@gorhom/bottom-sheet";
import { Portal } from "@gorhom/portal";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FloatingSurface } from "@/components/ui/floating";
import { useHoverSafeZone } from "@/hooks/use-hover-safe-zone";
import { useVortonTouch } from "@/vorton-touch";
import { OVERLAY_Z, useWebOverlayRegistration } from "@/lib/overlay-root";
import { isWeb } from "@/constants/platform";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

/** A non-modal project flyout: hovering never steals focus or blocks the rail. */
export function ProjectRailPreview({
  project,
  workspaceEntries,
  initials,
  onSelect,
}: {
  project: SidebarProjectEntry;
  workspaceEntries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  initials: string;
  onSelect: (key: string) => void;
}) {
  const bottomSheetInternal = useBottomSheetModalInternal(true);
  const triggerRef = useRef<View>(null);
  const contentRef = useRef<View>(null);
  const restoringFocus = useRef(false);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const touch = useVortonTouch();
  const { width, height } = useWindowDimensions();
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    clear();
    request.current += 1;
    setAnchor(null);
  }, [clear]);
  const open = useCallback(() => {
    clear();
    const current = ++request.current;
    triggerRef.current?.measureInWindow((x, y, w) => {
      if (current === request.current) setAnchor({ x: x + w + 8, y });
    });
  }, [clear]);
  const leave = useCallback(() => {
    clear();
    timer.current = setTimeout(() => {
      // A pointer departure must not dismiss a preview still being used by keyboard.
      if (isWeb) {
        const focused = document.activeElement;
        if (
          [triggerRef, contentRef].some((ref) =>
            (ref.current as unknown as HTMLElement | null)?.contains(focused),
          )
        )
          return;
      }
      close();
    }, 250);
  }, [clear, close]);
  const enter = useCallback(() => {
    if (!touch && !restoringFocus.current) open();
  }, [touch, open]);
  useHoverSafeZone({
    enabled: Boolean(anchor) && !touch,
    triggerRef,
    contentRef,
    onEnterSafeZone: clear,
    onLeaveSafeZone: leave,
  });
  useEffect(() => clear, [clear]);
  useEffect(() => close(), [width, height, close]);
  const handleOverlayKey = useCallback(
    (event: KeyboardEvent) => {
      if (
        event.key === "ArrowRight" &&
        (triggerRef.current as unknown as HTMLElement | null)?.contains(document.activeElement)
      ) {
        event.preventDefault();
        (contentRef.current as unknown as HTMLElement | null)
          ?.querySelector<HTMLElement>("button")
          ?.focus();
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        restoringFocus.current = true;
        (triggerRef.current as unknown as HTMLElement | null)
          ?.querySelector<HTMLElement>("button")
          ?.focus();
        restoringFocus.current = false;
        return true;
      }
      return false;
    },
    [close],
  );
  const setOverlayScope = useWebOverlayRegistration({
    active: isWeb && Boolean(anchor),
    layer: OVERLAY_Z.tooltip,
    onKeyDown: handleOverlayKey,
    focusBehavior: "none",
  });

  useEffect(() => {
    if (!isWeb || !anchor) return;
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const contains = (ref: typeof triggerRef) =>
        (ref.current as unknown as HTMLElement | null)?.contains(target);
      if (!contains(triggerRef) && !contains(contentRef)) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [anchor, close]);
  const previewHeight = Math.min(480, height - 24);
  const frame = useMemo(
    () => ({
      position: "absolute" as const,
      left: Math.max(8, Math.min(anchor?.x ?? 8, width - 368)),
      top: Math.max(8, Math.min(anchor?.y ?? 8, height - previewHeight - 8)),
    }),
    [anchor, width, height, previewHeight],
  );
  const selectProject = useCallback(() => {
    close();
    onSelect(project.viewKey);
  }, [close, onSelect, project.viewKey]);
  const rows = project.workspaces.map((workspace) => (
    <ProjectWorkspaceRow
      key={workspace.workspaceKey}
      workspace={workspace}
      name={workspaceEntries.get(workspace.workspaceKey)?.name ?? workspace.name}
      close={close}
    />
  ));
  return (
    <View ref={triggerRef} collapsable={false} onPointerEnter={enter} onPointerLeave={leave}>
      <Button
        variant="ghost"
        accessibilityLabel={`${project.projectName}, ${project.workspaces.length} workspaces`}
        onPress={anchor ? close : open}
        onFocus={enter}
        style={styles.tile}
        testID={`project-rail-${project.viewKey}`}
      >
        {initials}
      </Button>
      {anchor ? (
        <Portal hostName={bottomSheetInternal?.hostName}>
          <View ref={setOverlayScope} pointerEvents="box-none" style={styles.overlay}>
            <FloatingSurface
              ref={contentRef}
              style={[styles.card, { width: Math.min(360, width - 16), maxHeight: previewHeight }]}
              frameStyle={frame}
              onPointerEnter={clear}
              onPointerLeave={leave}
              accessibilityRole="menu"
              accessibilityLabel={`${project.projectName} workspaces`}
              testID="project-rail-preview"
            >
              <Text style={styles.title}>{project.projectName}</Text>
              <Text style={styles.description}>{project.workspaces.length} active workspaces</Text>
              <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
                {rows}
                {!project.workspaces.length ? (
                  <Text style={styles.description}>No active workspaces</Text>
                ) : null}
              </ScrollView>
              <Button variant="ghost" onPress={selectProject}>
                Show project in sidebar
              </Button>
            </FloatingSurface>
          </View>
        </Portal>
      ) : null}
    </View>
  );
}
function ProjectWorkspaceRow({
  workspace,
  name,
  close,
}: {
  workspace: SidebarProjectEntry["workspaces"][number];
  name: string;
  close: () => void;
}) {
  const select = useCallback(() => {
    close();
    router.push(buildHostWorkspaceRoute(workspace.serverId, workspace.workspaceId));
  }, [close, workspace.serverId, workspace.workspaceId]);
  return (
    <Button variant="ghost" style={styles.row} onPress={select}>
      {name}
    </Button>
  );
}
const styles = StyleSheet.create((theme) => ({
  tile: { width: 44, height: 44, paddingHorizontal: 0 },
  overlay: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 1000 },
  card: {
    padding: 12,
    gap: 8,
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  description: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  list: { flexShrink: 1 },
  row: { minHeight: 44, justifyContent: "flex-start" },
}));
