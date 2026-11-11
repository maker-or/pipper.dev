/**
 * Where a held tab belongs while it is dragged along a strip.
 *
 * A neighbour swaps with the held tab once the held tab has travelled
 * `threshold` of the narrower tab's width into it. Every position here is a
 * slot (where a tab will rest, worked out from the order and the widths taken
 * when the drag began), never a tab's animated position, so a neighbour still
 * sliding into place can't trigger or undo a swap.
 *
 * Below 50% a swap would undo itself at once: right after it, the held tab
 * covers more of the neighbour's new slot than the threshold. So undoing a
 * swap also needs the held tab to come back past the point where it happened
 * by `hysteresis` of the narrower width.
 */

export interface TabReorderOptions {
  /** Fraction of the narrower tab the held tab must overlap to swap. */
  threshold: number;
  /** Fraction of the narrower tab to come back before a swap undoes. */
  hysteresis: number;
}

export const DEFAULT_TAB_REORDER: TabReorderOptions = {
  threshold: 0.45,
  hysteresis: 0.1,
};

/** Where and which way the held tab was when it last passed each neighbour. */
export type TabSwapMemory = ReadonlyMap<string, { left: number; direction: 1 | -1 }>;

export interface TabReorderInput {
  /** Movable tabs in their current order. Fixed tabs are left out. */
  order: readonly string[];
  /** Each tab's width when the drag began, including anything that moves with it. */
  widths: ReadonlyMap<string, number>;
  /** Space between neighbouring tabs. */
  gap: number;
  /** Left of the first slot, in strip coordinates (scroll included). */
  origin: number;
  heldId: string;
  /** Left of the held tab, in the same coordinates as `origin`. */
  heldLeft: number;
  memory: TabSwapMemory;
}

export interface TabReorderResult {
  order: string[];
  memory: TabSwapMemory;
}

export function slotLefts(
  order: readonly string[],
  widths: ReadonlyMap<string, number>,
  gap: number,
  origin: number,
): number[] {
  const lefts: number[] = [];
  let x = origin;
  for (const id of order) {
    lefts.push(x);
    x += (widths.get(id) ?? 0) + gap;
  }
  return lefts;
}

export function reorderHeldTab(
  input: TabReorderInput,
  options: TabReorderOptions = DEFAULT_TAB_REORDER,
): TabReorderResult {
  const order = [...input.order];
  const memory = new Map(input.memory);
  const unchanged = { order, memory };
  const heldWidth = input.widths.get(input.heldId);
  if (heldWidth === undefined || !order.includes(input.heldId)) return unchanged;

  // A fast drag can pass several tabs at once; settle one swap at a time so
  // the gap ripples along. Each pass moves the held tab one slot, so this
  // ends within order.length passes.
  for (let pass = 0; pass < order.length; pass++) {
    const index = order.indexOf(input.heldId);
    const lefts = slotLefts(order, input.widths, input.gap, input.origin);
    // Head towards the side of its own slot the held tab is on.
    const direction = input.heldLeft > lefts[index] ? 1 : input.heldLeft < lefts[index] ? -1 : 0;
    if (direction === 0) break;
    const neighbourIndex = index + direction;
    if (neighbourIndex < 0 || neighbourIndex >= order.length) break;
    const neighbourId = order[neighbourIndex];
    const neighbourWidth = input.widths.get(neighbourId) ?? 0;
    const narrower = Math.min(heldWidth, neighbourWidth);
    const overlap =
      direction === 1
        ? input.heldLeft + heldWidth - lefts[neighbourIndex]
        : lefts[neighbourIndex] + neighbourWidth - input.heldLeft;
    if (overlap < options.threshold * narrower) break;

    const last = memory.get(neighbourId);
    if (last && last.direction === -direction) {
      const back = options.hysteresis * narrower;
      const cameBack =
        direction === 1 ? input.heldLeft >= last.left + back : input.heldLeft <= last.left - back;
      if (!cameBack) break;
    }

    order[index] = neighbourId;
    order[neighbourIndex] = input.heldId;
    memory.set(neighbourId, { left: input.heldLeft, direction });
  }
  return { order, memory };
}

/**
 * The drag's order against tabs that changed during the drag: tabs that
 * closed drop out, tabs that opened join at the end, and the rest keep the
 * order the drag gave them.
 */
export function reconcileDragOrder(
  dragOrder: readonly string[],
  current: readonly string[],
): string[] {
  const present = new Set(current);
  const kept = dragOrder.filter((id) => present.has(id));
  const seen = new Set(kept);
  return [...kept, ...current.filter((id) => !seen.has(id))];
}

/**
 * Past either end of the strip a held tab moves a fraction of the pointer's
 * travel, so the edge pushes back instead of stopping it dead.
 */
export function rubberBand(value: number, min: number, max: number, elastic = 0.2): number {
  if (value < min) return min - (min - value) * elastic;
  if (value > max) return max + (value - max) * elastic;
  return value;
}

/** A pointer position and when it was there, in ms. */
export interface PointerSample {
  x: number;
  t: number;
}

/** How far back release velocity looks. */
const VELOCITY_WINDOW_MS = 100;
/** A pointer that sat this long before lifting was at rest. */
const VELOCITY_STALE_MS = 50;

/**
 * The pointer's speed (px/s) when it lifted, from the samples of the last
 * `VELOCITY_WINDOW_MS`. A pointer that paused before lifting has none.
 */
export function releaseVelocity(samples: readonly PointerSample[], now: number): number {
  const last = samples.at(-1);
  if (!last || now - last.t > VELOCITY_STALE_MS) return 0;
  const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last;
  const dt = last.t - first.t;
  return dt > 0 ? ((last.x - first.x) / dt) * 1000 : 0;
}
