import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import {
  isSameSidebarFocus,
  resolveSidebarFocus,
  sidebarFocusAncestors,
  type SidebarFocusTarget,
  type SidebarFocusWorld,
} from "./model";
import { useSidebarFocusStore } from "./store";

/** Marks the element whose keyboard focus lets Escape leave sidebar focus. */
export const SIDEBAR_FOCUS_SCOPE = { sidebarFocusScope: "" } as const;

export interface SidebarFocusController {
  /** The item shown as the top level, after falling back from removed items. */
  focus: SidebarFocusTarget | null;
  focusOn: (target: SidebarFocusTarget | null) => void;
  /** True once after a user changes focus, so the breadcrumb can take keyboard focus. */
  takeKeyboardFocusRequest: () => boolean;
}

const SidebarFocusContext = createContext<SidebarFocusController | null>(null);

export const SidebarFocusProvider = SidebarFocusContext.Provider;

function isKeyboardFocusInSidebar(): boolean {
  if (!isWeb || typeof document === "undefined") return false;
  return document.activeElement?.closest("[data-sidebar-focus-scope]") != null;
}

/**
 * Owns sidebar focus for one project-mode list. Escape leaves focus while keyboard focus is
 * inside the sidebar; elsewhere Escape keeps its usual meaning, such as interrupting an agent.
 */
export function useSidebarFocusController(input: {
  world: SidebarFocusWorld;
  enabled: boolean;
}): SidebarFocusController {
  const { world, enabled } = input;
  const stored = useSidebarFocusStore((state) => state.focus);
  const setFocus = useSidebarFocusStore((state) => state.setFocus);
  const keyboardFocusRequestRef = useRef(false);
  const focus = useMemo(
    () => (enabled ? resolveSidebarFocus(stored, world) : null),
    [enabled, stored, world],
  );
  const focusOn = useCallback(
    (target: SidebarFocusTarget | null) => {
      keyboardFocusRequestRef.current = true;
      setFocus(target ? { target, ancestors: sidebarFocusAncestors(target, world) } : null);
    },
    [setFocus, world],
  );
  const takeKeyboardFocusRequest = useCallback(() => {
    const requested = keyboardFocusRequestRef.current;
    keyboardFocusRequestRef.current = false;
    return requested;
  }, []);

  useKeyboardActionHandler({
    handlerId: "sidebar-focus-exit",
    actions: ["agent.interrupt"],
    enabled: focus !== null,
    priority: 400,
    isActive: isKeyboardFocusInSidebar,
    handle: () => {
      focusOn(null);
      return true;
    },
  });

  return useMemo(
    () => ({ focus, focusOn, takeKeyboardFocusRequest }),
    [focus, focusOn, takeKeyboardFocusRequest],
  );
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
