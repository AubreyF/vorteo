import { memo, useCallback, useMemo, useRef, useLayoutEffect, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import {
  DndContext,
  closestCenter,
  pointerWithin,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  type Modifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  DraggableListProps,
  DraggableRenderItemInfo,
  DraggableListDropTarget,
  DraggableTreePlacement,
} from "./draggable-list.types";
import { DraggableTreeList } from "./draggable-tree-list.web";
import { getDragActivationConstraints, useDragReorderState } from "./drag-reorder";

import { useOptimisticReorder } from "./drag-reorder/use-optimistic-reorder";
import { useShallowStableRecord, useStableListenerRecord } from "./drag-reorder/stable-records";

export type { DraggableListProps, DraggableRenderItemInfo };

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const DND_MODIFIERS = [restrictToVerticalAxis];
const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};

interface SortableItemProps<T> {
  id: string;
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  activeId: string | null;
  useDragHandle: boolean;
}

function SortableItemInner<T>({
  id,
  item,
  index,
  renderItem,
  activeId,
  useDragHandle,
}: SortableItemProps<T>) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const dragRef = useRef<(() => void) | null>(null);

  const drag = useCallback(() => {
    // dnd-kit handles drag initiation via listeners
    // This is a no-op but matches the mobile API
  }, []);

  // Store listeners in ref so drag handle can access them
  dragRef.current = () => {
    // Trigger drag - handled by dnd-kit's listeners
  };

  // dnd-kit can set `scaleX/scaleY` on the active item when dragging over a
  // differently-sized droppable. For variable-height rows this can look like
  // the "ghost" stretches. Keep the dragged item's size stable by zeroing
  // out the dnd-kit scaling component.
  const baseTransform = CSS.Transform.toString(
    transform && isDragging ? { ...transform, scaleX: 1, scaleY: 1 } : transform,
  );
  const scaleTransform = isDragging ? "scale(1.02)" : "";
  const combinedTransform = [baseTransform, scaleTransform].filter(Boolean).join(" ");

  const style = useMemo(
    () => ({
      transform: combinedTransform || undefined,
      transition,
      opacity: isDragging ? 0.9 : 1,
      zIndex: isDragging ? 1000 : 1,
    }),
    [combinedTransform, transition, isDragging],
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

  const info: DraggableRenderItemInfo<T> = {
    item,
    index,
    drag,
    isActive: activeId === id,
    dragHandleProps,
  };

  const wrapperProps = useDragHandle
    ? { ref: setNodeRef }
    : { ref: setNodeRef, ...attributes, ...listeners };

  return (
    <div {...wrapperProps} style={style}>
      {renderItem(info)}
    </div>
  );
}

const SortableItem = memo(SortableItemInner) as typeof SortableItemInner;

function ExternalDropTarget({ id, element }: DraggableListDropTarget) {
  const { setNodeRef } = useDroppable({ id });
  useLayoutEffect(() => {
    setNodeRef(element);
    return () => setNodeRef(null);
  }, [element, setNodeRef]);
  return null;
}

export function DraggableList<T, P extends DraggableTreePlacement = DraggableTreePlacement>(
  props: DraggableListProps<T, P>,
) {
  const { treeDrop } = props;
  if (treeDrop) return <DraggableTreeList {...props} treeDrop={treeDrop} />;
  return <SortableDraggableList {...props} />;
}

function SortableDraggableList<T, P extends DraggableTreePlacement>({
  externalDrop,
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  style,
  containerStyle,
  contentContainerStyle,
  testID,
  ListFooterComponent,
  ListHeaderComponent,
  ListEmptyComponent,
  showsVerticalScrollIndicator = true,
  scrollEnabled = true,
  extraData: _extraData,
  useDragHandle = false,
  touchActivation = "hold",
  // simultaneousGestureRef is native-only, ignored on web
  onDragBegin,
  nestable: _nestable = false,
}: DraggableListProps<T, P>) {
  const optimistic = useOptimisticReorder(data, keyExtractor, onDragEnd);
  const { activeId, items, handlers } = useDragReorderState({
    data: optimistic.items,
    keyExtractor,
    onDragEnd: optimistic.drop,
    onDragBegin,
  });
  const activationConstraints = getDragActivationConstraints(
    useDragHandle && touchActivation === "hold",
    DRAG_ACTIVATION_CONFIG,
  );

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: activationConstraints.mouse,
    }),
    useSensor(TouchSensor, {
      activationConstraint: activationConstraints.touch,
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(
    () => items.map((item, index) => keyExtractor(item, index)),
    [items, keyExtractor],
  );
  const externalIds = useMemo(
    () => new Set(externalDrop?.targets.map((target) => target.id)),
    [externalDrop?.targets],
  );
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (!externalDrop) return closestCenter(args);
      const external = args.droppableContainers.filter((target) =>
        externalIds.has(String(target.id)),
      );
      const hits = pointerWithin({ ...args, droppableContainers: external });
      if (hits.length) return hits;
      const local = args.droppableContainers.filter(
        (target) => !externalIds.has(String(target.id)),
      );
      return closestCenter({ ...args, droppableContainers: local });
    },
    [externalDrop, externalIds],
  );
  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      const id = event.over ? String(event.over.id) : null;
      const item = items.find(
        (entry, index) => keyExtractor(entry, index) === String(event.active.id),
      );
      externalDrop?.onTargetChange(id && externalIds.has(id) ? id : null, item);
    },
    [externalDrop, externalIds, items, keyExtractor],
  );
  const onDragCancel = useCallback(() => {
    externalDrop?.onTargetChange(null);
    handlers.onDragCancel();
  }, [externalDrop, handlers]);
  const finishDrag = useCallback(
    (event: DragEndEvent) => {
      externalDrop?.onTargetChange(null);
      const targetId = event.over ? String(event.over.id) : null;
      if (externalDrop && targetId && externalIds.has(targetId)) {
        const item = items.find(
          (entry, index) => keyExtractor(entry, index) === String(event.active.id),
        );
        handlers.onDragCancel();
        if (item) externalDrop.onDrop(item, targetId);
        return;
      }
      handlers.onDragEnd(event);
    },
    [externalDrop, externalIds, handlers, items, keyExtractor],
  );
  const wrapperStyle = useMemo(
    () => [
      { position: "relative" as const },
      scrollEnabled ? { flex: 1, minHeight: 0 } : null,
      containerStyle,
    ],
    [scrollEnabled, containerStyle],
  );

  return (
    <View style={wrapperStyle}>
      {scrollEnabled ? (
        <ScrollView
          testID={testID}
          style={style}
          contentContainerStyle={contentContainerStyle}
          showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        >
          {ListHeaderComponent}
          {items.length === 0 && ListEmptyComponent}
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={DND_MODIFIERS}
            onDragStart={handlers.onDragStart}
            onDragOver={onDragOver}
            onDragCancel={onDragCancel}
            onDragEnd={finishDrag}
          >
            {externalDrop?.targets.map((target) => (
              <ExternalDropTarget key={target.id} {...target} />
            ))}
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {items.map((item, index) => {
                const id = keyExtractor(item, index);
                return (
                  <SortableItem
                    key={id}
                    id={id}
                    item={item}
                    index={index}
                    renderItem={renderItem}
                    activeId={activeId}
                    useDragHandle={useDragHandle}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {ListFooterComponent}
        </ScrollView>
      ) : (
        <>
          {ListHeaderComponent}
          {items.length === 0 && ListEmptyComponent}
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={DND_MODIFIERS}
            onDragStart={handlers.onDragStart}
            onDragOver={onDragOver}
            onDragCancel={onDragCancel}
            onDragEnd={finishDrag}
          >
            {externalDrop?.targets.map((target) => (
              <ExternalDropTarget key={target.id} {...target} />
            ))}
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {items.map((item, index) => {
                const id = keyExtractor(item, index);
                return (
                  <SortableItem
                    key={id}
                    id={id}
                    item={item}
                    index={index}
                    renderItem={renderItem}
                    activeId={activeId}
                    useDragHandle={useDragHandle}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {ListFooterComponent}
        </>
      )}
    </View>
  );
}
