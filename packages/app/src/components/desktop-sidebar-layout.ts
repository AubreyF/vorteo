import { SETTINGS_DESKTOP_SPLIT_MIN_WIDTH, DESKTOP_TRAFFIC_LIGHT_WIDTH } from "@/constants/layout";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { COMPACT_SIDEBAR_WIDTH, SIDEBAR_OUTER_GAP } from "@/stores/panel-store/state";

const MIN_DESKTOP_CENTER_WIDTH = 400;
const COMPACT_LABELED_SIDEBAR_WIDTH = 240;

export function resolveDesktopSidebarVisibility(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isMounted: boolean;
  isOpen: boolean;
  canShare: boolean;
}): boolean {
  return (
    input.chromeEnabled &&
    !input.isCompactLayout &&
    input.isMounted &&
    input.isOpen &&
    input.canShare
  );
}

export function resolveDesktopAppChromeLayout(input: {
  desktopSidebarRendered: boolean;
  hasTopLeftWindowControls: boolean;
  sidebarControlsEnabled: boolean;
}) {
  const sidebarOwnsTopLeft = input.desktopSidebarRendered && input.hasTopLeftWindowControls;
  let sidebarToggleOwner: "none" | "window" | "content" = "none";
  if (input.sidebarControlsEnabled) {
    sidebarToggleOwner = input.hasTopLeftWindowControls ? "window" : "content";
  }
  return {
    sidebarCorners: sidebarOwnsTopLeft ? ("top-left" as const) : ("none" as const),
    contentCorners: sidebarOwnsTopLeft ? ("top-right" as const) : ("both" as const),
    sidebarToggleOwner,
  };
}

function resolveDesktopPanelWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
  minimumWidth: number;
  maximumWidth: number;
}): number {
  "worklet";
  const maximumVisibleWidth = Math.max(
    input.minimumWidth,
    Math.min(
      input.maximumWidth,
      input.viewportWidth - MIN_DESKTOP_CENTER_WIDTH - SIDEBAR_OUTER_GAP * 2,
    ),
  );
  return Math.max(input.minimumWidth, Math.min(maximumVisibleWidth, input.requestedWidth));
}

export function resolveDesktopSidebarWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
  compact?: boolean;
  narrow?: boolean;
  hasTopLeftWindowControls?: boolean;
}): number {
  "worklet";
  if (input.compact)
    return input.hasTopLeftWindowControls
      ? Math.max(COMPACT_SIDEBAR_WIDTH, DESKTOP_TRAFFIC_LIGHT_WIDTH)
      : COMPACT_SIDEBAR_WIDTH;
  return resolveDesktopPanelWidth({
    ...input,
    requestedWidth: input.narrow ? COMPACT_LABELED_SIDEBAR_WIDTH : input.requestedWidth,
    minimumWidth: MIN_SIDEBAR_WIDTH,
    maximumWidth: MAX_SIDEBAR_WIDTH,
  });
}

export function resolveDesktopAppContentMinimum(input: { isSettingsRoute: boolean }): number {
  return input.isSettingsRoute ? SETTINGS_DESKTOP_SPLIT_MIN_WIDTH : 0;
}

export function canDesktopAppSidebarShare(input: {
  contentMinimumWidth: number;
  requestedSidebarWidth: number;
  viewportWidth: number;
  compact?: boolean;
  narrow?: boolean;
  hasTopLeftWindowControls?: boolean;
}): boolean {
  return (
    input.viewportWidth -
      resolveDesktopSidebarWidth({
        requestedWidth: input.requestedSidebarWidth,
        viewportWidth: input.viewportWidth,
        compact: input.compact,
        narrow: input.narrow,
        hasTopLeftWindowControls: input.hasTopLeftWindowControls,
      }) -
      SIDEBAR_OUTER_GAP * 2 >=
    input.contentMinimumWidth
  );
}
