import { createContext, useCallback, useContext, useMemo } from "react";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import {
  isSameSidebarFocus,
  resolveSidebarFocus,
  sidebarRowFocusVisibility,
  storedSidebarFocus,
  type SidebarFocusTarget,
  type SidebarFocusWorld,
} from "./model";
import { useSidebarFocusStore } from "./store";
import { useSidebarFolderStore } from "@/sidebar-folders/store";

export interface SidebarFocusController {
  /** The item shown as the top level, after falling back from removed items. */
  focus: SidebarFocusTarget | null;
  focusOn: (target: SidebarFocusTarget | null) => void;
}

const SidebarFocusContext = createContext<SidebarFocusController | null>(null);

export const SidebarFocusProvider = SidebarFocusContext.Provider;

/** Owns sidebar focus for one project-mode list. The breadcrumb is the only way out. */
export function useSidebarFocusController(input: {
  world: SidebarFocusWorld;
  enabled: boolean;
}): SidebarFocusController {
  const { world, enabled } = input;
  const stored = useSidebarFocusStore((state) => state.focus);
  const setFocus = useSidebarFocusStore((state) => state.setFocus);
  const focus = useMemo(
    () => (enabled ? resolveSidebarFocus(stored, world) : null),
    [enabled, stored, world],
  );
  const focusOn = useCallback(
    (target: SidebarFocusTarget | null) => {
      setFocus(target ? storedSidebarFocus(target, world) : null);
    },
    [setFocus, world],
  );
  return useMemo(() => ({ focus, focusOn }), [focus, focusOn]);
}

/**
 * Focuses a project from outside the expanded list, such as the compact rail's flyout footer.
 * It writes the same store, in the same shape, as the project row's Focus button; ancestors
 * come from the stored folders, which is all a project's ancestry depends on.
 */
export function focusSidebarProject(projectKey: string): void {
  const folders = useSidebarFolderStore.getState();
  const world: SidebarFocusWorld = {
    folders: folders.sidebarFolders,
    itemFolder: folders.itemFolder,
    projects: new Map(),
    hiddenFolderIds: new Set(),
  };
  useSidebarFocusStore
    .getState()
    .setFocus(storedSidebarFocus({ kind: "project", projectKey }, world));
}

export function useSidebarFocus(): SidebarFocusController | null {
  return useContext(SidebarFocusContext);
}

/**
 * Focuses a row's item, or null where focus is unavailable: outside project mode, in the
 * compact rail, or on the row that is already the focused top level.
 */
export function useSidebarFocusAction(target: SidebarFocusTarget): (() => void) | null {
  const context = useContext(SidebarFocusContext);
  const focusOn = context?.focusOn;
  const isRoot = context ? isSameSidebarFocus(context.focus, target) : false;
  const action = useCallback(() => focusOn?.(target), [focusOn, target]);
  return focusOn && !isRoot ? action : null;
}

export interface SidebarRowFocus {
  /** The focused top level: it shows no arrow and does not fold away. */
  isRoot: boolean;
  /**
   * The Focus button beside the row's ⋮ menu, under the condition that shows ⋮: on hover with
   * a pointer, and always where rows cannot be hovered. Null while hidden.
   */
  buttonAction: (() => void) | null;
  /** Hover with a pointer only, for a row showing no ⋮ menu, such as a folded project. */
  hoverAction: (() => void) | null;
}

/** Focus affordances for a project or folder row. */
export function useSidebarRowFocus(input: {
  target: SidebarFocusTarget;
  isHovered: boolean;
}): SidebarRowFocus {
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  const context = useContext(SidebarFocusContext);
  const action = useSidebarFocusAction(input.target);
  const visibility = sidebarRowFocusVisibility({
    isHovered: input.isHovered,
    hoverUnavailable: touch || compact || isNative,
  });
  return {
    isRoot: context ? isSameSidebarFocus(context.focus, input.target) : false,
    buttonAction: visibility.button ? action : null,
    hoverAction: visibility.hoverOnly ? action : null,
  };
}
