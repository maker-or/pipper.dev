"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  animate,
  motion,
  motionValue,
  useReducedMotion,
  type AnimationPlaybackControls,
  type MotionValue,
  type Transition,
} from "framer-motion";
import { cn } from "@/lib/utils";
import {
  reconcileDragOrder,
  releaseVelocity,
  reorderHeldTab,
  rubberBand,
  type PointerSample,
  type TabSwapMemory,
} from "@/lib/tab-reorder";

/**
 * Drag-to-reorder for a list along one axis, built as a direct-manipulation
 * gesture. Used by the tab strip (x) and the project rail (y).
 *
 * Track: while the pointer is down, the held item IS the pointer. Its offset
 * from its slot is a motion value written on every pointermove (no React
 * state, no spring), so it never trails. Neighbours slide out of its way on
 * layout springs; `reorderHeldTab` decides every swap. Past the list's ends
 * it rubber-bands, and near its visible edges the list scrolls.
 *
 * Release: a spring seeded with the pointer's release velocity carries the
 * item into its slot. That spring can be caught: pressing the item mid-flight
 * picks it up exactly where it is.
 *
 * The list must be its items' offsetParent (give it `position: relative`):
 * slots are read from offsetLeft / offsetTop.
 *
 * Wire it up as:
 *   const reorder = useDragReorder({ axis, ids, listRef, onCommit });
 *   <div ref={listRef} className="relative …">
 *     {reorder.order.map((id) => <DragReorderItem reorder={reorder} id={id} …>)}
 */

export type DragAxis = "x" | "y";

/** How items slide when the order changes under a drag. */
export const DRAG_LAYOUT_SPRING = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;
/** A move this far lifts the item, so a click with a slight wobble stays a click. */
export const DRAG_ACTIVATION_PX = 6;
/** A drag with the pointer this close to the list's visible edge scrolls it. */
const AUTO_SCROLL_EDGE_PX = 40;
/** Fastest auto-scroll, at the very edge, in px per frame. */
const AUTO_SCROLL_MAX_SPEED = 14;
/** Release velocity is capped so a wild flick can't fling an item off screen. */
const MAX_RELEASE_VELOCITY = 4000;
/** A drag pushes the item, so it lands with a small bounce. */
export const RELEASE_SPRING: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.2 };
/** Reduced motion: no fling, no bounce, a short settle. */
export const RELEASE_SPRING_REDUCED: Transition = {
  type: "spring",
  visualDuration: 0.15,
  bounce: 0,
};
/** Elastic of the list's ends. */
export const EDGE_ELASTIC = 0.2;

interface AxisReader {
  pointer: (event: { clientX: number; clientY: number }) => number;
  /** Viewport start of an element's box. */
  start: (rect: DOMRect) => number;
  end: (rect: DOMRect) => number;
  border: (el: HTMLElement) => number;
  scroll: "scrollLeft" | "scrollTop";
  visible: (el: HTMLElement) => number;
  content: (el: HTMLElement) => number;
  /** Layout position within the offsetParent, untouched by transforms. */
  offset: (el: HTMLElement) => number;
  size: (el: HTMLElement) => number;
  gap: (style: CSSStyleDeclaration) => string;
}

const AXES: Record<DragAxis, AxisReader> = {
  x: {
    pointer: (event) => event.clientX,
    start: (rect) => rect.left,
    end: (rect) => rect.right,
    border: (el) => el.clientLeft,
    scroll: "scrollLeft",
    visible: (el) => el.clientWidth,
    content: (el) => el.scrollWidth,
    offset: (el) => el.offsetLeft,
    size: (el) => el.offsetWidth,
    gap: (style) => style.columnGap,
  },
  y: {
    pointer: (event) => event.clientY,
    start: (rect) => rect.top,
    end: (rect) => rect.bottom,
    border: (el) => el.clientTop,
    scroll: "scrollTop",
    visible: (el) => el.clientHeight,
    content: (el) => el.scrollHeight,
    offset: (el) => el.offsetTop,
    size: (el) => el.offsetHeight,
    gap: (style) => style.rowGap,
  },
};

/** The selector a `DragReorderItem` answers to. */
export function dragItemSelector(id: string) {
  return `[data-drag-item="${CSS.escape(id)}"]`;
}

/**
 * An item's size along the axis, and how much of it (things that travel with
 * it) sits before the item itself.
 */
export type DragGroupMeasure = (
  list: HTMLElement,
  id: string,
  gap: number,
) => { lead: number; size: number };

function measureItemAlone(axis: DragAxis): DragGroupMeasure {
  return (list, id) => {
    const item = list.querySelector<HTMLElement>(dragItemSelector(id));
    return { lead: 0, size: item ? AXES[axis].size(item) : 0 };
  };
}

/** One press on an item, from pointerdown until it is let go. */
interface DragSession {
  id: string;
  pointerId: number;
  element: HTMLElement;
  startX: number;
  startY: number;
  /** Last pointer position along the axis. */
  last: number;
  /** Passed the activation distance (or caught mid-flight): the item is held. */
  active: boolean;
  /** Order when the drag began, for Escape. */
  startOrder: string[];
  order: string[];
  sizes: Map<string, number>;
  gap: number;
  origin: number;
  /** Pointer to the held group's start edge, in list coordinates. */
  grabOffset: number;
  /** The pointer had to be pulled back by the rubber band. */
  banded: boolean;
  memory: TabSwapMemory;
  samples: PointerSample[];
  autoScrollFrame: number | null;
  cleanup: () => void;
}

export interface DragReorder {
  axis: DragAxis;
  /** Items in display order. */
  order: string[];
  /** The item under the pointer, if one is held. */
  heldId: string | null;
  /** Items off their slot: held, or springing back into place. */
  liftedIds: readonly string[];
  /** An item's offset from its slot. Things that travel with it share it. */
  offsetFor: (id: string) => MotionValue<number>;
  onPointerDown: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  /**
   * Read-only: the spring an item is settling on, if any, as it was started.
   * For tools that document the gesture (the spec posters); the app never
   * reads it.
   */
  settleOf: (id: string) => SettleInfo | null;
}

/** A settle spring as the hook started it. */
export interface SettleInfo {
  controls: AnimationPlaybackControls;
  /** Offset it started from. */
  from: number;
  /** Release velocity it was seeded with, px/s. */
  velocity: number;
  transition: Transition;
}

export function useDragReorder({
  axis,
  ids,
  listRef,
  measure,
  onCommit,
}: {
  axis: DragAxis;
  /** Movable items in their resting order. */
  ids: readonly string[];
  listRef: RefObject<HTMLElement | null>;
  measure?: DragGroupMeasure;
  /** Persists a new order; the list holds it until this settles. */
  onCommit: (order: string[]) => Promise<void> | void;
}): DragReorder {
  const reduceMotion = useReducedMotion() ?? false;
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [heldId, setHeldId] = useState<string | null>(null);
  const [liftedIds, setLiftedIds] = useState<string[]>([]);

  // Items that come or go mid-drag join or leave the drag's order.
  const order = useMemo(
    () => (dragIds ? reconcileDragOrder(dragIds, ids) : [...ids]),
    [dragIds, ids],
  );

  // Handlers run outside React; they read the latest render through refs.
  const latest = useRef({
    ids,
    order,
    measure: measure ?? measureItemAlone(axis),
    onCommit,
    reduceMotion,
    ax: AXES[axis],
  });
  latest.current = {
    ids,
    order,
    measure: measure ?? measureItemAlone(axis),
    onCommit,
    reduceMotion,
    ax: AXES[axis],
  };

  const sessionRef = useRef<DragSession | null>(null);
  const offsets = useRef(new Map<string, MotionValue<number>>());
  const settles = useRef(new Map<string, AnimationPlaybackControls>());
  const settleInfo = useRef(new Map<string, SettleInfo>());
  /** Each lifted item's slot (start of its group) as last laid out. */
  const slots = useRef(new Map<string, number>());
  const pendingCommits = useRef(0);

  const offsetFor = useCallback((id: string) => {
    let value = offsets.current.get(id);
    if (!value) {
      value = motionValue(0);
      offsets.current.set(id, value);
    }
    return value;
  }, []);

  const gapOf = (list: HTMLElement) =>
    Number.parseFloat(latest.current.ax.gap(getComputedStyle(list))) || 0;

  /**
   * Screen px per layout px along the axis: 1 in the app, other than 1 when
   * the list sits inside a CSS-scaled container. Pointer positions are screen
   * px and slots are layout px, so every pointer distance goes through this.
   */
  const screenScale = (list: HTMLElement) => {
    const { ax } = latest.current;
    const rect = list.getBoundingClientRect();
    const size = ax.size(list);
    return size > 0 ? (ax.end(rect) - ax.start(rect)) / size : 1;
  };

  /** Pointer position in list coordinates (layout px, scroll included). */
  const listPosition = (list: HTMLElement, pointer: number) => {
    const { ax } = latest.current;
    const fromStart = (pointer - ax.start(list.getBoundingClientRect())) / screenScale(list);
    return fromStart - ax.border(list) + list[ax.scroll];
  };

  const slotOf = (id: string): number | null => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(dragItemSelector(id));
    if (!list || !item) return null;
    // Layout position, so a neighbour mid-slide never moves a slot.
    return latest.current.ax.offset(item) - latest.current.measure(list, id, gapOf(list)).lead;
  };

  const lift = (id: string) =>
    setLiftedIds((current) => (current.includes(id) ? current : [...current, id]));
  const land = (id: string) => {
    slots.current.delete(id);
    setLiftedIds((current) => current.filter((value) => value !== id));
  };

  /** Spring a lifted item home to offset 0, from wherever and however fast it is going. */
  const settle = (id: string, velocity: number) => {
    settles.current.get(id)?.stop();
    const reduced = latest.current.reduceMotion;
    const transition = reduced ? RELEASE_SPRING_REDUCED : RELEASE_SPRING;
    const seeded = reduced ? 0 : velocity;
    const from = offsetFor(id).get();
    const controls = animate(offsetFor(id), 0, { ...transition, velocity: seeded });
    settles.current.set(id, controls);
    settleInfo.current.set(id, { controls, from, velocity: seeded, transition });
    void controls.then(() => {
      if (settles.current.get(id) !== controls) return;
      settles.current.delete(id);
      if (sessionRef.current?.id !== id) land(id);
    });
  };

  // A lifted item's slot moves when the order changes (a swap, an item
  // coming or going, the saved order arriving). Shift its offset by the same
  // amount before paint so it stays exactly where it was on screen; an item
  // mid-flight keeps its velocity through the shift.
  useLayoutEffect(() => {
    for (const id of liftedIds) {
      const slot = slotOf(id);
      if (slot === null) continue;
      const previous = slots.current.get(id);
      slots.current.set(id, slot);
      if (previous === undefined || previous === slot) continue;
      const offset = offsetFor(id);
      const settling = settles.current.get(id);
      const velocity = offset.getVelocity();
      settling?.stop();
      offset.jump(offset.get() + previous - slot);
      if (settling) settle(id, velocity);
    }
  });

  /** Recompute the held item from the last pointer position. */
  const track = (session: DragSession) => {
    const list = listRef.current;
    if (!list) return;
    const { ids: currentIds, measure: measureGroup } = latest.current;
    const current = reconcileDragOrder(session.order, currentIds);
    for (const id of current) {
      if (session.sizes.has(id)) continue;
      session.sizes.set(id, measureGroup(list, id, session.gap).size);
    }
    const heldSize = session.sizes.get(session.id) ?? 0;
    const total =
      current.reduce((sum, id) => sum + (session.sizes.get(id) ?? 0), 0) +
      session.gap * Math.max(0, current.length - 1);
    const raw = listPosition(list, session.last) - session.grabOffset;
    const max = session.origin + total - heldSize;
    const held = rubberBand(raw, session.origin, max, EDGE_ELASTIC);
    session.banded = held !== raw;

    const result = reorderHeldTab({
      order: current,
      widths: session.sizes,
      gap: session.gap,
      origin: session.origin,
      heldId: session.id,
      heldLeft: held,
      memory: session.memory,
    });
    session.memory = result.memory;
    session.order = result.order;
    if (result.order.some((id, index) => id !== current[index])) setDragIds(result.order);
    // Against the slot as laid out now; the layout effect shifts it when the
    // swap renders.
    const slot = slots.current.get(session.id) ?? session.origin;
    offsetFor(session.id).set(held - slot);
  };

  const autoScroll = (session: DragSession) => {
    const list = listRef.current;
    session.autoScrollFrame = null;
    if (!list || sessionRef.current !== session) return;
    const { ax } = latest.current;
    const rect = list.getBoundingClientRect();
    const fromStart = session.last - ax.start(rect);
    const fromEnd = ax.end(rect) - session.last;
    let step = 0;
    if (fromStart < AUTO_SCROLL_EDGE_PX && list[ax.scroll] > 0) {
      step = -AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, fromStart) / AUTO_SCROLL_EDGE_PX);
    } else if (
      fromEnd < AUTO_SCROLL_EDGE_PX &&
      list[ax.scroll] + ax.visible(list) < ax.content(list)
    ) {
      step = AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, fromEnd) / AUTO_SCROLL_EDGE_PX);
    }
    // The scroll listener re-tracks the item once the list moves.
    if (step !== 0) list[ax.scroll] += step;
    session.autoScrollFrame = requestAnimationFrame(() => autoScroll(session));
  };

  const activate = (session: DragSession) => {
    const list = listRef.current;
    if (!list) return false;
    const { order: currentOrder, measure: measureGroup } = latest.current;
    const first = currentOrder[0];
    if (first === undefined || !currentOrder.includes(session.id)) return false;
    const gap = gapOf(list);
    const sizes = new Map<string, number>();
    for (const id of currentOrder) sizes.set(id, measureGroup(list, id, gap).size);
    const slot = slotOf(session.id);
    const origin = slotOf(first);
    if (slot === null || origin === null) return false;

    settles.current.get(session.id)?.stop();
    settles.current.delete(session.id);
    // Picked up where it is on screen, mid-flight included.
    const heldStart = slot + offsetFor(session.id).get();
    Object.assign(session, {
      active: true,
      startOrder: [...currentOrder],
      order: [...currentOrder],
      sizes,
      gap,
      origin,
      grabOffset: listPosition(list, session.last) - heldStart,
    });
    slots.current.set(session.id, slot);
    try {
      session.element.setPointerCapture(session.pointerId);
    } catch {
      // The pointer is already gone; pointerup/cancel ends the session.
    }
    lift(session.id);
    setHeldId(session.id);
    setDragIds([...currentOrder]);
    session.autoScrollFrame = requestAnimationFrame(() => autoScroll(session));
    return true;
  };

  const end = (session: DragSession, outcome: "drop" | "cancel") => {
    if (sessionRef.current !== session) return;
    sessionRef.current = null;
    session.cleanup();
    if (!session.active) return;

    // The release swallows the click it would fire (opening the item, or a
    // close button under the pointer).
    const swallowClick = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);

    setHeldId(null);
    const { ids: currentIds } = latest.current;
    const stillThere = currentIds.includes(session.id);
    const next = reconcileDragOrder(session.order, currentIds);
    const moved = next.some((id, index) => id !== currentIds[index]);
    const list = listRef.current;
    const k = list ? screenScale(list) : 1;
    const velocity =
      outcome === "drop"
        ? Math.max(
            -MAX_RELEASE_VELOCITY,
            Math.min(MAX_RELEASE_VELOCITY, releaseVelocity(session.samples, performance.now()) / k),
          ) * (session.banded ? EDGE_ELASTIC : 1)
        : 0;

    if (stillThere) settle(session.id, velocity);
    else land(session.id);

    if (outcome === "cancel" || !stillThere || !moved) {
      if (pendingCommits.current === 0) setDragIds(null);
      else setDragIds(reconcileDragOrder(session.startOrder, currentIds));
      return;
    }
    setDragIds(next);
    pendingCommits.current += 1;
    void Promise.resolve()
      .then(() => latest.current.onCommit(next))
      .catch(() => {})
      .finally(() => {
        pendingCommits.current -= 1;
        if (pendingCommits.current === 0 && !sessionRef.current) setDragIds(null);
      });
  };

  const onPointerDown = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || sessionRef.current) return;
    const { ax } = latest.current;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const session: DragSession = {
      id,
      pointerId,
      element,
      startX: event.clientX,
      startY: event.clientY,
      last: ax.pointer(event),
      active: false,
      startOrder: [],
      order: [],
      sizes: new Map(),
      gap: 0,
      origin: 0,
      grabOffset: 0,
      banded: false,
      memory: new Map(),
      samples: [{ x: ax.pointer(event), t: performance.now() }],
      autoScrollFrame: null,
      cleanup: () => {},
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      session.last = latest.current.ax.pointer(move);
      const now = performance.now();
      session.samples.push({ x: session.last, t: now });
      while (session.samples.length > 2 && now - session.samples[0].t > 150) {
        session.samples.shift();
      }
      if (!session.active) {
        const distance = Math.hypot(move.clientX - session.startX, move.clientY - session.startY);
        if (distance < DRAG_ACTIVATION_PX || !activate(session)) return;
      }
      track(session);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId === pointerId) end(session, "drop");
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) end(session, "cancel");
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !session.active) return;
      key.preventDefault();
      key.stopPropagation();
      end(session, "cancel");
    };
    const onBlur = () => end(session, "cancel");
    const onScroll = () => {
      if (session.active) track(session);
    };
    const list = listRef.current;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    list?.addEventListener("scroll", onScroll, { passive: true });
    session.cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      list?.removeEventListener("scroll", onScroll);
      if (session.autoScrollFrame !== null) cancelAnimationFrame(session.autoScrollFrame);
      try {
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
    };
    sessionRef.current = session;

    // Catching an item mid-flight picks it up at once, wherever it is.
    if (settles.current.has(id) && activate(session)) track(session);
  };

  // A held item that goes away mid-drag cancels the drag.
  useEffect(() => {
    const current = sessionRef.current;
    if (current?.active && !ids.includes(current.id)) end(current, "cancel");
  }, [ids]);

  useEffect(
    () => () => {
      const current = sessionRef.current;
      if (current) {
        sessionRef.current = null;
        current.cleanup();
      }
      for (const controls of settles.current.values()) controls.stop();
    },
    [],
  );

  const settleOf = useCallback((id: string) => {
    const info = settleInfo.current.get(id);
    return info && settles.current.get(id) === info.controls ? info : null;
  }, []);

  return { axis, order, heldId, liftedIds, offsetFor, onPointerDown, settleOf };
}

/**
 * An item in a drag-reorderable list. Pressing and moving it picks it up; it
 * follows the pointer 1:1 and springs into its slot on release.
 *
 * With `followId` it doesn't drag on its own but travels with that item (a
 * terminal tab anchored to its thread). Otherwise idle items slide with their
 * neighbours when the order changes.
 */
export function DragReorderItem({
  reorder,
  id,
  followId,
  disabled,
  heldScale = 1.04,
  className,
  style,
  onClickCapture,
  children,
  ...props
}: {
  reorder: DragReorder;
  /** Required unless `followId` is given. */
  id?: string;
  followId?: string;
  disabled?: boolean;
  /** How much bigger the held item is drawn. Smaller items need more. */
  heldScale?: number;
  className?: string;
  style?: CSSProperties;
  onClickCapture?: MouseEventHandler<HTMLDivElement>;
  children?: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  const reduceMotion = useReducedMotion();
  const target = followId ?? id;
  const lifted = target !== undefined && reorder.liftedIds.includes(target);
  const held = !followId && id !== undefined && reorder.heldId === id;
  const dragId = !followId && !disabled ? id : undefined;
  const draggable = dragId !== undefined;
  return (
    <motion.div
      // A lifted item is placed by its offset, never by a layout animation.
      layout={!lifted}
      transition={DRAG_LAYOUT_SPRING}
      animate={{ scale: held && !reduceMotion ? heldScale : 1 }}
      style={{
        ...style,
        ...(target === undefined ? {} : { [reorder.axis]: reorder.offsetFor(target) }),
        zIndex: lifted ? 30 : style?.zIndex,
        touchAction: draggable ? "none" : style?.touchAction,
      }}
      className={cn(draggable && (held ? "cursor-grabbing" : "cursor-grab"), className)}
      onPointerDown={
        dragId === undefined ? undefined : (event) => reorder.onPointerDown(dragId, event)
      }
      onClickCapture={onClickCapture}
      data-drag-item={followId ? undefined : id}
      data-held={held || undefined}
      {...props}
    >
      {children}
    </motion.div>
  );
}
