import { createContext, useCallback, useContext, useMemo } from "react";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import {
  isSameSidebarFocus,
  resolveSidebarFocus,
  sidebarFocusAncestors,
  type SidebarFocusTarget,
  type SidebarFocusWorld,
} from "./model";
import { useSidebarFocusStore } from "./store";

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
      setFocus(target ? { target, ancestors: sidebarFocusAncestors(target, world) } : null);
    },
    [setFocus, world],
  );
  return useMemo(() => ({ focus, focusOn }), [focus, focusOn]);
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
  /** The hover button's action; null while not hovered and where hover is unavailable. */
  buttonAction: (() => void) | null;
  /** The menu item's action, offered only where rows cannot be hovered. */
  menuAction: (() => void) | null;
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
  const hoverUnavailable = touch || compact || isNative;
  return {
    isRoot: context ? isSameSidebarFocus(context.focus, input.target) : false,
    buttonAction: input.isHovered && !hoverUnavailable ? action : null,
    menuAction: hoverUnavailable ? action : null,
  };
}
