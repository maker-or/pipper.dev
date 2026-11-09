"use client";

import {
  cloneElement,
  isValidElement,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  type CollisionDetection,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimation,
  type Modifier,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { motion, useReducedMotion } from "framer-motion";
import { TabDragPreview } from "@/components/ui/tabs";
import { Elevated } from "@/lib/elevated";
import { useShape } from "@/lib/shape-context";
import { springs } from "@/lib/springs";
import { cn } from "@/lib/utils";
import { reconcileDragOrder, reorderHeldTab, type TabSwapMemory } from "@/lib/tab-reorder";

/**
 * Drag-to-reorder for a TabsList. The held tab lifts into a DragOverlay
 * (`HeldTab`), its slot stays in the strip as the gap (`SortableTab`), and
 * neighbours slide on layout springs. `reorderHeldTab` decides every swap;
 * dnd-kit only reports where the pointer is.
 *
 * Wire it up as:
 *   <DndContext sensors={TAB_DRAG_SENSORS} collisionDetection={noCollisions}
 *     {...reorder.handlers}>
 *     <SortableContext items={reorder.order}>
 *       <TabsList ref={listRef} heldValue={reorder.heldId}>…
 *     <DragOverlay modifiers={[resistVertical]} dropAnimation={TAB_DROP_ANIMATION}>
 *       <HeldTab … />
 */

/** How tabs slide when the order changes under a drag. */
export const TAB_LAYOUT_SPRING = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;
/** The held tab settling into its gap on drop. */
export const TAB_DROP_ANIMATION: DropAnimation = {
  duration: 220,
  easing: "cubic-bezier(0.2, 0.9, 0.3, 1)",
};
/** A move this far lifts the tab, so a click with a slight wobble stays a click. */
export const TAB_DRAG_ACTIVATION = { distance: 6 };
/** Free vertical travel for a held tab before it starts to resist. */
const TAB_DRAG_FREE_Y = 24;

/** dnd-kit's collision rules stay out of it: `reorderHeldTab` decides swaps. */
export const noCollisions: CollisionDetection = () => [];

/** A held tab moves freely sideways but feels tied to the strip up and down. */
export const resistVertical: Modifier = ({ transform }) => {
  const distance = Math.abs(transform.y);
  if (distance <= TAB_DRAG_FREE_Y) return transform;
  const resisted = TAB_DRAG_FREE_Y + (distance - TAB_DRAG_FREE_Y) * 0.35;
  return { ...transform, y: Math.sign(transform.y) * resisted };
};

function withIndex(children: ReactNode, _index: number | undefined) {
  return isValidElement(children)
    ? cloneElement(children as ReactElement, { _index } as Record<string, unknown>)
    : children;
}

/** The selector `SortableTab` answers to, for measuring a tab's width. */
export function sortableTabSelector(id: string) {
  return `[data-sortable-tab="${CSS.escape(id)}"]`;
}

/**
 * A draggable tab. While held it stays in the strip as plain empty space the
 * tab will drop into; the tab itself is drawn by `HeldTab`.
 * `value` mirrors the child's, so TabsList can read the strip's order.
 */
export function SortableTab({
  id,
  value,
  _index,
  children,
  disabled,
  ...props
}: {
  id: string;
  value: string;
  _index?: number;
  children: ReactNode;
  disabled?: boolean;
  "data-pipper-id"?: string;
}) {
  void value;
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id, disabled });
  return (
    <motion.div
      ref={setNodeRef}
      layout
      transition={TAB_LAYOUT_SPRING}
      style={{ touchAction: "none" }}
      className={isDragging ? "cursor-grabbing [&>[role=tab]]:invisible" : "cursor-grab"}
      {...attributes}
      {...listeners}
      data-sortable-tab={id}
      {...props}
    >
      {withIndex(children, _index)}
    </motion.div>
  );
}

/** A tab that doesn't drag but slides with its neighbours when they reorder. */
export function LayoutTab({
  value,
  _index,
  children,
  ...props
}: {
  value: string;
  _index?: number;
  children: ReactNode;
  "data-pipper-id"?: string;
}) {
  void value;
  return (
    <motion.div layout transition={TAB_LAYOUT_SPRING} {...props}>
      {withIndex(children, _index)}
    </motion.div>
  );
}

/** The held tab, lifted out of the strip. Render inside DragOverlay. */
export function HeldTab(props: {
  icon?: (props: { className?: string; size?: number }) => ReactElement;
  label: string;
  selected: boolean;
  attention?: boolean;
}) {
  const shape = useShape();
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={{ scale: 1 }}
      animate={{ scale: reduceMotion ? 1 : 1.04 }}
      transition={springs.fast}
      className="size-full cursor-grabbing"
      data-pipper-id="held-tab"
    >
      <Elevated offset={2} className={cn("flex size-full items-center", shape.bg)}>
        <TabDragPreview {...props} />
      </Elevated>
    </motion.div>
  );
}

/** A tab's width and how much of it (things that travel with it) sits before the tab. */
export type TabGroupMeasure = (
  list: HTMLElement,
  id: string,
  gap: number,
) => { lead: number; width: number };

const measureTabAlone: TabGroupMeasure = (list, id) => ({
  lead: 0,
  width: list.querySelector<HTMLElement>(sortableTabSelector(id))?.offsetWidth ?? 0,
});

export function useTabDragReorder({
  ids,
  listRef,
  measure = measureTabAlone,
  onCommit,
}: {
  /** Movable tabs in their resting order. */
  ids: readonly string[];
  listRef: RefObject<HTMLElement | null>;
  measure?: TabGroupMeasure;
  /** Persists a new order; the strip holds it until this settles. */
  onCommit: (order: string[]) => Promise<void> | void;
}) {
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [heldId, setHeldId] = useState<string | null>(null);
  // Widths and the slot origin are taken once when the drag begins, so tabs
  // sliding mid-animation never move the swap points.
  const geometryRef = useRef<{
    widths: Map<string, number>;
    leads: Map<string, number>;
    gap: number;
    origin: number;
    memory: TabSwapMemory;
  } | null>(null);

  // Tabs that open or close mid-drag join or leave the drag's order.
  const order = useMemo(
    () => (dragIds ? reconcileDragOrder(dragIds, ids) : [...ids]),
    [dragIds, ids],
  );

  const reset = () => {
    geometryRef.current = null;
    setHeldId(null);
    setDragIds(null);
  };

  const onDragStart = (event: DragStartEvent) => {
    const list = listRef.current;
    const first = ids[0];
    if (!list || first === undefined) return;
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    const widths = new Map<string, number>();
    const leads = new Map<string, number>();
    for (const id of ids) {
      const { lead, width } = measure(list, id, gap);
      widths.set(id, width);
      leads.set(id, lead);
    }
    const listLeft = list.getBoundingClientRect().left;
    const firstLeft =
      list.querySelector<HTMLElement>(sortableTabSelector(first))?.getBoundingClientRect().left ??
      listLeft;
    const origin = firstLeft - listLeft + list.scrollLeft - (leads.get(first) ?? 0);
    geometryRef.current = { widths, leads, gap, origin, memory: new Map() };
    setHeldId(String(event.active.id));
    setDragIds([...ids]);
  };

  const onDragMove = (event: DragMoveEvent) => {
    const geometry = geometryRef.current;
    const list = listRef.current;
    const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;
    if (!geometry || !list || !rect || !dragIds) return;
    const id = String(event.active.id);
    const current = reconcileDragOrder(dragIds, ids);
    for (const tabId of current) {
      if (geometry.widths.has(tabId)) continue;
      const { lead, width } = measure(list, tabId, geometry.gap);
      geometry.widths.set(tabId, width);
      geometry.leads.set(tabId, lead);
    }
    // Strip coordinates, so auto-scroll never moves a slot by itself.
    const heldLeft =
      rect.left -
      list.getBoundingClientRect().left +
      list.scrollLeft -
      (geometry.leads.get(id) ?? 0);
    const result = reorderHeldTab({
      order: current,
      widths: geometry.widths,
      gap: geometry.gap,
      origin: geometry.origin,
      heldId: id,
      heldLeft,
      heldOffsetY: event.delta.y,
      memory: geometry.memory,
    });
    geometry.memory = result.memory;
    if (result.order.some((tabId, index) => tabId !== current[index])) setDragIds(result.order);
  };

  const onDragEnd = async () => {
    // Drops where the gap shows; the swap rule doesn't run again on release.
    const next = dragIds ? reconcileDragOrder(dragIds, ids) : null;
    const held = heldId;
    geometryRef.current = null;
    setHeldId(null);
    const moved = next?.some((id, index) => id !== ids[index]) ?? false;
    // A held tab that closed mid-drag cancels the move.
    if (!next || held === null || !ids.includes(held) || !moved) {
      setDragIds(null);
      return;
    }
    try {
      await onCommit(next);
    } finally {
      setDragIds(null);
    }
  };

  return {
    order,
    heldId,
    handlers: { onDragStart, onDragMove, onDragEnd, onDragCancel: reset },
  };
}
