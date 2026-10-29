import type { ReactElement, MutableRefObject } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { GestureType } from "react-native-gesture-handler";

export interface DraggableListDragHandleProps {
  /**
   * Web-only drag handle props (from dnd-kit). Spread these onto the element
   * that should initiate the drag. Native uses the `drag()` callback instead.
   */
  attributes?: Record<string, unknown>;
  listeners?: Record<string, unknown>;
  setActivatorNodeRef?: (node: unknown) => void;
}

export interface DraggableRenderItemInfo<T> {
  item: T;
  index: number;
  drag: () => void;
  isActive: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

export interface DraggableListDropTarget {
  id: string;
  element: HTMLElement;
}

export interface DraggableListExternalDrop<T> {
  targets: readonly DraggableListDropTarget[];
  onDrop: (item: T, targetId: string) => void;
  onTargetChange: (targetId: string | null, item?: T) => void;
}

/** What a tree drop needs to draw its indicator; resolvers may return more. */
export interface DraggableTreePlacement {
  mode: "between" | "into";
  depth: number;
  /** Into drops: the receiving row's key, highlighted when it is in this list. */
  container: string | null;
  /** Between drops: the row the insertion line sits above, or null below the last row. */
  lineBeforeKey: string | null;
}

export interface DraggableTreeDropInput {
  activeKey: string;
  /** The row under the pointer; the dragged row's key while over its own slot. */
  overKey: string;
  overFraction: number;
  /** The dragged row's leading edge, which follows the pointer horizontally. */
  pointerX: number;
  /** Where depth-0 content starts, in the same coordinates. */
  rowContentStartX: number;
  previousDepth: number | null;
}

/**
 * Web and Electron: the list drops by position instead of reordering. Rows stay in place while
 * an insertion line or container highlight shows where the dragged row will land.
 */
export interface DraggableListTreeDrop<T, P extends DraggableTreePlacement> {
  /** Pixels per depth step. */
  indentUnit: number;
  /** Where depth-0 content starts, measured from the list's left edge. */
  baseInset: number;
  depthOf: (item: T) => number;
  /** "cancel" ends drops released above or below the list without moving anything. */
  outside: "clamp" | "cancel";
  resolve: (input: DraggableTreeDropInput) => P | null;
  onDrop: (activeKey: string, placement: P) => void;
  onDragStart: (activeKey: string) => void;
  /** Called after a drop or a cancel. */
  onDragEnd: () => void;
}

export interface DraggableListProps<T, P extends DraggableTreePlacement = DraggableTreePlacement> {
  /** Web and Electron: registered targets outside this sortable list. */
  externalDrop?: DraggableListExternalDrop<T>;
  /** Web and Electron: drop by position in a tree. Native keeps `onDragEnd` reordering. */
  treeDrop?: DraggableListTreeDrop<T, P>;
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  /**
   * Return the save promise to keep the dropped order visible until data acknowledges it.
   * `movedKey` names the dragged row, which the order alone cannot tell for adjacent swaps.
   */
  onDragEnd: (data: T[], movedKey: string) => void | Promise<unknown>;
  style?: StyleProp<ViewStyle>;
  /** Outer container style (useful for nested, non-scrolling lists). */
  containerStyle?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  ListFooterComponent?: ReactElement | null;
  ListHeaderComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  showsVerticalScrollIndicator?: boolean;
  /** When false, disables internal scrolling (use outer list to scroll). */
  scrollEnabled?: boolean;
  /**
   * Web-only: when true, the drag can only be initiated from the handle props
   * passed to `renderItem` (prevents nested lists from fighting).
   */
  useDragHandle?: boolean;
  /** Dedicated handles can start touch drags on movement without a hold. */
  touchActivation?: "hold" | "movement";
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Fill remaining space when content is smaller than container */
  contentContainerFlexGrow?: boolean;
  /** External row state that should invalidate virtualized native cells. */
  extraData?: unknown;
  /** Gesture ref for simultaneous handling with parent gestures (e.g., sidebar close) */
  simultaneousGestureRef?: MutableRefObject<GestureType | undefined>;
  /** Whether the retained native gesture host is currently presented. */
  gestureHostPresented?: boolean;
  /** Gesture ref(s) that the list should wait for before handling scroll */
  waitFor?: MutableRefObject<GestureType | undefined> | MutableRefObject<GestureType | undefined>[];
  /** Called when a drag gesture begins (before items are reordered) */
  onDragBegin?: () => void;
  /** Called immediately before invoking row `drag()` to lock outer owners. */
  onDragIntent?: () => void;
  /** Called when drag interaction ends (finger released). */
  onDragRelease?: () => void;
  /**
   * Native-only: use the nestable draggable-flatlist variant for nested drag
   * lists coordinated by a shared NestableScrollContainer.
   */
  nestable?: boolean;
}
