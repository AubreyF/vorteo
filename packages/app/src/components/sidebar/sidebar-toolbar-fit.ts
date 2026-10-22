import { FLOATING_PANEL_CONTROL_HEIGHT } from "@/styles/floating-panel";

/** Every sidebar toolbar control is a square button of the shared control height. */
export const SIDEBAR_TOOLBAR_BUTTON_SIZE = FLOATING_PANEL_CONTROL_HEIGHT;
/** Collapse, search and the actions menu are always visible. */
const FIXED_BUTTONS = 3;
/** Smallest space kept between the leading controls and the trailing group, so they never touch. */
export const SIDEBAR_TOOLBAR_GROUP_GAP = 8;
/** Schedules, History and Settings, in the order they leave the toolbar for the actions menu. */
export const SIDEBAR_TOOLBAR_OPTIONAL_BUTTONS = 3;

/**
 * How many optional navigation buttons fit beside the fixed controls. Buttons move into the
 * actions menu only when the toolbar is too narrow to show them without overlap.
 */
export function sidebarToolbarFit(availableWidth: number): number {
  if (!Number.isFinite(availableWidth)) return SIDEBAR_TOOLBAR_OPTIONAL_BUTTONS;
  const buttons = Math.floor(
    (availableWidth - SIDEBAR_TOOLBAR_GROUP_GAP) / SIDEBAR_TOOLBAR_BUTTON_SIZE,
  );
  return Math.max(0, Math.min(SIDEBAR_TOOLBAR_OPTIONAL_BUTTONS, buttons - FIXED_BUTTONS));
}
