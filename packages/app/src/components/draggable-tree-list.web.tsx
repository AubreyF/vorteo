import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { getDragActivationConstraints } from "./drag-reorder";
import { useShallowStableRecord, useStableListenerRecord } from "./drag-reorder/stable-records";
import type {
  DraggableListDropTarget,
  DraggableListProps,
  DraggableListTreeDrop,
  DraggableRenderItemInfo,
  DraggableTreePlacement,
} from "./draggable-list.types";

const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const DND_MODIFIERS = [restrictToVerticalAxis];
const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};
const containerStyle: CSSProperties = { position: "relative" };
const LINE_THICKNESS = 2;

type TreeIndicator =
  | { kind: "line"; top: number; left: number }
  | { kind: "into"; top: number; height: number };

interface TreeGesture<P> {
  activeKey: string;
  startX: number;
  activeDepth: number;
  startOffsetTop: number;
  pointerX: number;
  pointerY: number;
  placement: P | null;
  overExternal: boolean;
  frame: number | null;
}

interface PointerTarget {
  overKey: string;
  overFraction: number;
  outside: boolean;
}

function sameIndicator(left: TreeIndicator | null, right: TreeIndicator | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "line" && right.kind === "line") {
    return left.top === right.top && left.left === right.left;
  }
  if (left.kind === "into" && right.kind === "into") {
    return left.top === right.top && left.height === right.height;
  }
  return false;
}

/** The listed row under `y`, treating the dragged row's empty slot as its own. */
function locatePointer(input: {
  y: number;
  keys: readonly string[];
  activeKey: string;
  nodes: ReadonlyMap<string, HTMLElement>;
  container: HTMLElement;
}): PointerTarget {
  const { y, keys, activeKey, nodes, container } = input;
  const activeNode = nodes.get(activeKey);
  const containerTop = container.getBoundingClientRect().top;
  const slotTop = containerTop + (activeNode?.offsetTop ?? 0);
  const slotBottom = slotTop + (activeNode?.offsetHeight ?? 0);
  if (y >= slotTop && y < slotBottom)
    return { overKey: activeKey, overFraction: 0.5, outside: false };
  const rows = keys.flatMap((key) => {
    const node = key === activeKey ? undefined : nodes.get(key);
    return node ? [{ key, rect: node.getBoundingClientRect() }] : [];
  });
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return { overKey: activeKey, overFraction: 0.5, outside: false };
  for (const row of rows) {
    if (y >= row.rect.top && y < row.rect.bottom) {
      return {
        overKey: row.key,
        overFraction: (y - row.rect.top) / row.rect.height,
        outside: false,
      };
    }
  }
  if (y < Math.min(first.rect.top, slotTop))
    return { overKey: first.key, overFraction: 0, outside: true };
  if (y >= Math.max(last.rect.bottom, slotBottom)) {
    return { overKey: last.key, overFraction: 1, outside: true };
  }
  const nearest = rows.reduce((best, row) => {
    const distance = Math.min(Math.abs(y - row.rect.top), Math.abs(y - row.rect.bottom));
    const bestDistance = Math.min(Math.abs(y - best.rect.top), Math.abs(y - best.rect.bottom));
    return distance < bestDistance ? row : best;
  });
  return { overKey: nearest.key, overFraction: y < nearest.rect.top ? 0 : 1, outside: false };
}

function indicatorFor<P extends DraggableTreePlacement>(input: {
  placement: P;
  keys: readonly string[];
  activeKey: string;
  nodes: ReadonlyMap<string, HTMLElement>;
  container: HTMLElement;
  indentUnit: number;
  baseInset: number;
}): TreeIndicator | null {
  const { placement, nodes, container } = input;
  const containerTop = container.getBoundingClientRect().top;
  if (placement.mode === "into") {
    const node = placement.container === null ? undefined : nodes.get(placement.container);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { kind: "into", top: rect.top - containerTop, height: rect.height };
  }
  const left = input.baseInset + placement.depth * input.indentUnit;
  const below = placement.lineBeforeKey === null ? undefined : nodes.get(placement.lineBeforeKey);
  if (below) return { kind: "line", top: below.offsetTop, left };
  const bottoms = input.keys.flatMap((key) => {
    const node = nodes.get(key);
    return node ? [node.offsetTop + node.offsetHeight] : [];
  });
  return { kind: "line", top: Math.max(0, ...bottoms), left };
}

interface TreeItemProps<T> {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  isActive: boolean;
  useDragHandle: boolean;
  layoutShift: number;
  registerNode: (key: string, node: HTMLElement | null) => void;
}

function TreeItemInner<T>({
  id,
  item,
  index,
  renderItem,
  isActive,
  useDragHandle,
  layoutShift,
  registerNode,
}: TreeItemProps<T>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform } = useDraggable({
    id,
  });
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      registerNode(id, node);
    },
    [setNodeRef, registerNode, id],
  );
  // Rows above may fold when the drag starts; the shift keeps this row under the pointer.
  const y = isActive && transform ? transform.y + layoutShift : 0;
  const style = useMemo<CSSProperties>(
    () => ({
      transform: isActive ? `translate3d(0, ${y}px, 0) scale(1.02)` : undefined,
      opacity: isActive ? 0.9 : 1,
      zIndex: isActive ? 1000 : 1,
      position: "relative",
    }),
    [isActive, y],
  );
  const stableAttributes = useShallowStableRecord(attributes as unknown as Record<string, unknown>);
  const stableListeners = useStableListenerRecord(
    listeners as unknown as Record<string, unknown> | undefined,
  );
  const dragHandleProps = useMemo(
    () =>
      useDragHandle
        ? {
            attributes: stableAttributes,
            listeners: stableListeners,
            setActivatorNodeRef: setActivatorNodeRef as unknown as (node: unknown) => void,
          }
        : undefined,
    [setActivatorNodeRef, stableAttributes, stableListeners, useDragHandle],
  );
  const wrapperProps = useDragHandle ? { ref } : { ref, ...attributes, ...listeners };
  return (
    <div {...wrapperProps} style={style}>
      {renderItem({ item, index, drag: noop, isActive, dragHandleProps })}
    </div>
  );
}

function noop() {}

const TreeItem = memo(TreeItemInner) as typeof TreeItemInner;

function ExternalDropTarget({ id, element }: DraggableListDropTarget) {
  const { setNodeRef } = useDroppable({ id });
  useLayoutEffect(() => {
    setNodeRef(element);
    return () => setNodeRef(null);
  }, [element, setNodeRef]);
  return null;
}

function TreeDropIndicator({ indicator }: { indicator: TreeIndicator }) {
  if (indicator.kind === "into") {
    return (
      <View
        pointerEvents="none"
        style={[styles.into, { top: indicator.top, height: indicator.height }]}
        testID="draggable-tree-into"
      />
    );
  }
  return (
    <View
      pointerEvents="none"
      style={[styles.line, { top: indicator.top - LINE_THICKNESS / 2, left: indicator.left }]}
      testID="draggable-tree-line"
    />
  );
}

/**
 * Web drop-by-position list. Rows stay where they are during a drag; the pointer chooses a
 * position through `treeDrop.resolve`, shown as an insertion line at the projected depth or a
 * highlighted container, and the owner performs the move.
 */
export function DraggableTreeList<T, P extends DraggableTreePlacement>({
  treeDrop,
  externalDrop,
  data,
  keyExtractor,
  renderItem,
  containerStyle: outerStyle,
  testID,
  ListFooterComponent,
  ListHeaderComponent,
  ListEmptyComponent,
  useDragHandle = false,
  touchActivation = "hold",
  onDragBegin,
}: DraggableListProps<T, P> & { treeDrop: DraggableListTreeDrop<T, P> }) {
  const activation = getDragActivationConstraints(
    useDragHandle && touchActivation === "hold",
    DRAG_ACTIVATION_CONFIG,
  );
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: activation.mouse }),
    useSensor(TouchSensor, { activationConstraint: activation.touch }),
    useSensor(KeyboardSensor),
  );
  const keys = useMemo(
    () => data.map((item, index) => keyExtractor(item, index)),
    [data, keyExtractor],
  );
  const latest = useRef({ data, keys, treeDrop, externalDrop });
  latest.current = { data, keys, treeDrop, externalDrop };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const gestureRef = useRef<TreeGesture<P> | null>(null);
  const listenerRef = useRef<(() => void) | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [indicator, setIndicator] = useState<TreeIndicator | null>(null);
  const [layoutShift, setLayoutShift] = useState(0);

  const registerNode = useCallback((key: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
  }, []);

  const itemFor = useCallback((key: string): T | undefined => {
    const index = latest.current.keys.indexOf(key);
    return index < 0 ? undefined : latest.current.data[index];
  }, []);

  const update = useCallback(() => {
    const gesture = gestureRef.current;
    const container = containerRef.current;
    if (!gesture || !container) return;
    gesture.frame = null;
    const { treeDrop: drop, keys: currentKeys } = latest.current;
    const target = locatePointer({
      y: gesture.pointerY,
      keys: currentKeys,
      activeKey: gesture.activeKey,
      nodes: nodes.current,
      container,
    });
    const left = container.getBoundingClientRect().left;
    const rowContentStartX = left + drop.baseInset;
    const placement =
      target.outside && drop.outside === "cancel"
        ? null
        : drop.resolve({
            activeKey: gesture.activeKey,
            overKey: target.overKey,
            overFraction: target.overFraction,
            pointerX:
              rowContentStartX +
              gesture.activeDepth * drop.indentUnit +
              (gesture.pointerX - gesture.startX),
            rowContentStartX,
            previousDepth: gesture.placement?.depth ?? null,
          });
    gesture.placement = placement;
    const next =
      placement && !gesture.overExternal
        ? indicatorFor({
            placement,
            keys: currentKeys,
            activeKey: gesture.activeKey,
            nodes: nodes.current,
            container,
            indentUnit: drop.indentUnit,
            baseInset: drop.baseInset,
          })
        : null;
    setIndicator((current) => (sameIndicator(current, next) ? current : next));
  }, []);

  const schedule = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.frame !== null) return;
    gesture.frame = requestAnimationFrame(update);
  }, [update]);

  const finish = useCallback(() => {
    const gesture = gestureRef.current;
    if (gesture?.frame != null) cancelAnimationFrame(gesture.frame);
    listenerRef.current?.();
    listenerRef.current = null;
    gestureRef.current = null;
    setActiveId(null);
    setIndicator(null);
    setLayoutShift(0);
    latest.current.externalDrop?.onTargetChange(null);
    latest.current.treeDrop.onDragEnd();
  }, []);

  useEffect(() => () => listenerRef.current?.(), []);

  // Folding rows above the dragged one moves it; measure after layout, before paint.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (activeId === null || !container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const gesture = gestureRef.current;
      const node = gesture ? nodes.current.get(gesture.activeKey) : undefined;
      if (!gesture || !node) return;
      setLayoutShift(gesture.startOffsetTop - node.offsetTop);
      schedule();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeId, schedule]);

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeKey = String(event.active.id);
      const item = itemFor(activeKey);
      const start = getEventCoordinates(event.activatorEvent);
      if (item === undefined || !start) return;
      const gesture: TreeGesture<P> = {
        activeKey,
        startX: start.x,
        activeDepth: latest.current.treeDrop.depthOf(item),
        startOffsetTop: nodes.current.get(activeKey)?.offsetTop ?? 0,
        pointerX: start.x,
        pointerY: start.y,
        placement: null,
        overExternal: false,
        frame: null,
      };
      gestureRef.current = gesture;
      const track = (pointer: PointerEvent) => {
        gesture.pointerX = pointer.clientX;
        gesture.pointerY = pointer.clientY;
        schedule();
      };
      window.addEventListener("pointermove", track);
      listenerRef.current = () => window.removeEventListener("pointermove", track);
      setActiveId(activeKey);
      latest.current.treeDrop.onDragStart(activeKey);
      onDragBegin?.();
    },
    [itemFor, onDragBegin, schedule],
  );

  const externalIds = useMemo(
    () => new Set(externalDrop?.targets.map((target) => target.id)),
    [externalDrop?.targets],
  );
  // Only external targets, such as other projects' headers, collide; rows resolve by position.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) =>
      pointerWithin({
        ...args,
        droppableContainers: args.droppableContainers.filter((target) =>
          externalIds.has(String(target.id)),
        ),
      }),
    [externalIds],
  );

  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      const gesture = gestureRef.current;
      const id = event.over ? String(event.over.id) : null;
      const external = id !== null && externalIds.has(id) ? id : null;
      if (gesture) gesture.overExternal = external !== null;
      latest.current.externalDrop?.onTargetChange(external, itemFor(String(event.active.id)));
      schedule();
    },
    [externalIds, itemFor, schedule],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const gesture = gestureRef.current;
      if (gesture?.frame != null) cancelAnimationFrame(gesture.frame);
      update();
      const overId = event.over ? String(event.over.id) : null;
      const item = itemFor(String(event.active.id));
      const { externalDrop: external, treeDrop: drop } = latest.current;
      if (external && overId !== null && externalIds.has(overId) && item !== undefined) {
        external.onDrop(item, overId);
      } else if (gesture?.placement) {
        drop.onDrop(gesture.activeKey, gesture.placement);
      }
      finish();
    },
    [externalIds, finish, itemFor, update],
  );

  return (
    <View style={[styles.wrapper, outerStyle]}>
      {ListHeaderComponent}
      {data.length === 0 && ListEmptyComponent}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={DND_MODIFIERS}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragCancel={finish}
        onDragEnd={onDragEnd}
      >
        {externalDrop?.targets.map((target) => (
          <ExternalDropTarget key={target.id} {...target} />
        ))}
        <div ref={containerRef} style={containerStyle} data-testid={testID}>
          {data.map((item, index) => {
            const id = keys[index]!;
            return (
              <TreeItem
                key={id}
                id={id}
                item={item}
                index={index}
                renderItem={renderItem}
                isActive={activeId === id}
                useDragHandle={useDragHandle}
                layoutShift={activeId === id ? layoutShift : 0}
                registerNode={registerNode}
              />
            );
          })}
          {indicator ? <TreeDropIndicator indicator={indicator} /> : null}
        </div>
      </DndContext>
      {ListFooterComponent}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrapper: { position: "relative" },
  line: {
    position: "absolute",
    right: theme.spacing[1],
    height: LINE_THICKNESS,
    borderRadius: LINE_THICKNESS,
    backgroundColor: theme.colors.accent,
    zIndex: 1001,
  },
  into: {
    position: "absolute",
    left: 0,
    right: 0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accentSubtle,
    zIndex: 0,
  },
}));
