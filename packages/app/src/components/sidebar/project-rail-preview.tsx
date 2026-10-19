import { getInterfaceScale } from "@/appearance/interface-zoom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useWindowDimensions } from "@/appearance/interface-geometry";
import { useBottomSheetModalInternal } from "@gorhom/bottom-sheet";
import { Portal } from "@gorhom/portal";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FloatingSurface } from "@/components/ui/floating";
import { useHoverSafeZone } from "@/hooks/use-hover-safe-zone";
import { useVortonTouch } from "@/vorton-touch";
import {
  OVERLAY_Z,
  OverlayLayerProvider,
  hasActiveWebOverlay,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { isWeb } from "@/constants/platform";
import { ProjectRailList } from "./project-rail-list";
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
  const pinned = useRef(false);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; centerY: number } | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const measureContent = useCallback(
    (_width: number, height: number) => setContentHeight(height),
    [],
  );
  const touch = useVortonTouch();
  const { width, height } = useWindowDimensions();
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    clear();
    request.current += 1;
    pinned.current = false;
    setAnchor(null);
  }, [clear]);
  const open = useCallback(() => {
    clear();
    const current = ++request.current;
    triggerRef.current?.measureInWindow((x, y, w, h) => {
      if (current === request.current)
        setAnchor({
          x: (x + w) / getInterfaceScale() + 8,
          y: y / getInterfaceScale(),
          centerY: (y + h / 2) / getInterfaceScale(),
        });
    });
  }, [clear]);
  const leave = useCallback(() => {
    clear();
    timer.current = setTimeout(() => {
      if (pinned.current || (isWeb && hasActiveWebOverlay())) return;
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
          ?.querySelector<HTMLElement>('[data-testid^="sidebar-workspace-row-"]')
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
      if (hasActiveWebOverlay()) return;
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
  // The footer target (44), body padding and border (18), and gap (8) surround the list.
  const previewHeight = Math.min(480, height - 24, contentHeight ? contentHeight + 70 : 480);
  const frame = useMemo(
    () => ({
      position: "absolute" as const,
      left: Math.max(8, Math.min(anchor?.x ?? 8, width - 408)),
      top: Math.max(8, Math.min(anchor?.y ?? 8, height - previewHeight - 8)),
    }),
    [anchor, width, height, previewHeight],
  );
  const selectProject = useCallback(() => {
    close();
    onSelect(project.viewKey);
  }, [close, onSelect, project.viewKey]);
  const click = useCallback(() => {
    pinned.current = true;
    open();
  }, [open]);
  const previewWidth = Math.min(400, width - 16);
  const tailStyle = {
    top: Math.max(16, Math.min((anchor?.centerY ?? 0) - frame.top - 5, previewHeight - 26)),
  };
  return (
    <View ref={triggerRef} collapsable={false} onPointerEnter={enter} onPointerLeave={leave}>
      <Button
        variant="ghost"
        accessibilityLabel={`${project.projectName}, ${project.workspaces.length} workspaces`}
        onPress={click}
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
              style={[styles.card, { width: previewWidth, height: previewHeight }]}
              frameStyle={frame}
              onPointerEnter={clear}
              onPointerLeave={leave}
              accessibilityRole="none"
              accessibilityLabel={`${project.projectName} workspaces`}
              testID="project-rail-preview"
            >
              <View
                pointerEvents="none"
                testID="project-rail-tail"
                style={[styles.tail, tailStyle]}
              />
              <OverlayLayerProvider layer={OVERLAY_Z.tooltip}>
                <ProjectRailList
                  project={project}
                  workspaceEntries={workspaceEntries}
                  width={previewWidth - 16}
                  onNavigate={close}
                  onContentSizeChange={measureContent}
                />
              </OverlayLayerProvider>
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
const styles = StyleSheet.create((theme) => ({
  tile: { width: 44, height: 44, paddingHorizontal: 0 },
  overlay: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 1000 },
  card: {
    padding: 8,
    gap: 8,
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  tail: {
    position: "absolute",
    left: -6,
    width: 10,
    height: 10,
    backgroundColor: theme.colors.surfaceSidebar,
    borderColor: theme.colors.border,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    transform: [{ rotate: "45deg" }],
  },
}));
