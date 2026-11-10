"use client";

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DragReorderItem, type DragReorder } from "@/components/drag-reorder";
import { Elevated } from "@/lib/elevated";
import { useShape } from "@/lib/shape-context";
import { cn } from "@/lib/utils";

/**
 * Tab-strip pieces for drag-to-reorder (see `useDragReorder` with axis "x").
 * The gesture lives in drag-reorder; this adds the tab look: a raised surface
 * under a tab while it is off its slot.
 */

function withIndex(children: ReactNode, _index: number | undefined) {
  return isValidElement(children)
    ? cloneElement(children as ReactElement, { _index } as Record<string, unknown>)
    : children;
}

/** The raised surface under a tab that is off its slot. */
function LiftedSurface({ lifted }: { lifted: boolean }) {
  const shape = useShape();
  return (
    <AnimatePresence>
      {lifted && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <Elevated offset={2} className={cn("size-full", shape.bg)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A draggable tab. `value` mirrors the child's, so TabsList can read the
 * strip's order.
 */
export function SortableTab({
  reorder,
  id,
  value,
  _index,
  children,
  disabled,
  ...props
}: {
  reorder: DragReorder;
  id: string;
  value: string;
  _index?: number;
  children: ReactNode;
  disabled?: boolean;
  "data-pipper-id"?: string;
}) {
  void value;
  return (
    <DragReorderItem reorder={reorder} id={id} disabled={disabled} className="relative" {...props}>
      <LiftedSurface lifted={reorder.liftedIds.includes(id)} />
      {withIndex(children, _index)}
    </DragReorderItem>
  );
}

/**
 * A tab that doesn't drag on its own. With `followId` it travels with that
 * tab when it is dragged; otherwise it slides with its neighbours.
 */
export function LayoutTab({
  reorder,
  followId,
  value,
  _index,
  children,
  ...props
}: {
  reorder: DragReorder;
  followId?: string;
  value: string;
  _index?: number;
  children: ReactNode;
  "data-pipper-id"?: string;
}) {
  void value;
  return (
    <DragReorderItem reorder={reorder} followId={followId} className="relative" {...props}>
      <LiftedSurface lifted={followId !== undefined && reorder.liftedIds.includes(followId)} />
      {withIndex(children, _index)}
    </DragReorderItem>
  );
}
