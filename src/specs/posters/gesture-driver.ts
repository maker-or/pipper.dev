import { useEffect, useRef, useState } from "react";
import { captureEach, type StateSnapshot } from "../kit/sheet-states";
import { oneCamera } from "../kit/spec-kit";

/**
 * The driver for a pointer gesture (see references/drivers.md in the
 * interface-bts skill). Each moment is a run: reset the component, drive it
 * there with synthetic pointer events, copy it. Afterwards the hero moment is
 * driven again and held, and picking a moment re-drives the component there.
 *
 * Synthetic events go to the subject's own elements and bubble from there,
 * so another poster on the page never sees them.
 */

/**
 * Pointer ids no real device uses, so the drag hook's capture calls fail
 * harmlessly. One per poster: the hook listens on the window, so posters on
 * one page must not share a pointer, or one poster's moves drive another's
 * drag.
 */
let nextPointerId = 7301;

/** Thrown when the component left the page mid-run (the poster redrew). */
class Gone extends Error {}

export interface RunContext {
  root: HTMLElement;
  /** This poster's own synthetic pointer, on one of its elements. */
  pointer: (el: Element) => ReturnType<typeof pointerOn>;
  /** Waits a frame; throws if the run is stale or the component is gone. */
  frame: () => Promise<void>;
  /** Waits until `done()` holds (polled each frame), up to `capMs`. */
  until: (done: () => boolean, capMs?: number) => Promise<void>;
}

export interface Moment<H> {
  label: string;
  /** Drives the component to the moment and holds it there. */
  run: (ctx: RunContext) => Promise<{ held: H; time: number }>;
}

/**
 * Synthetic mouse input on one element, as a real pointer would send it.
 * `cancel` ends the drag as the system would (pointercancel): it reverts the
 * order like Escape, but only for this pointer, where an Escape key would
 * reach every drag on the page.
 */
export function pointerOn(el: Element, pointerId: number) {
  const fire = (type: string, x: number, y: number, buttons: number) =>
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      }),
    );
  return {
    down: (x: number, y: number) => fire("pointerdown", x, y, 1),
    move: (x: number, y: number) => fire("pointermove", x, y, 1),
    up: (x: number, y: number) => fire("pointerup", x, y, 0),
    cancel: () => fire("pointercancel", 0, 0, 0),
  };
}

/** Centre of an element on screen. */
export function centreOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function useGestureSpec<H>({
  moments,
  hero,
  reset,
}: {
  moments: readonly Moment<H>[];
  /** Index of the moment the poster opens on. */
  hero: number;
  /** Puts the component back at rest: no drag, nothing moving, the first order. */
  reset: (ctx: RunContext) => Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<H | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState(hero);
  const [snapshots, setSnapshots] = useState<StateSnapshot[]>([]);
  const keep = useRef({ moments, reset });
  keep.current = { moments, reset };
  const generation = useRef(0);
  const alive = useRef(true);
  const [pointerId] = useState(() => nextPointerId++);

  const contextFor = (g: number): RunContext => {
    const r = root.current!;
    const check = () => {
      if (!alive.current || g !== generation.current || !r.isConnected || !r.offsetWidth) {
        throw new Gone();
      }
    };
    const frame = () =>
      new Promise<void>((resolve, reject) =>
        requestAnimationFrame(() => {
          try {
            check();
            resolve();
          } catch (e) {
            reject(e);
          }
        }),
      );
    const until = async (done: () => boolean, capMs = 3000) => {
      const start = performance.now();
      while (!done()) {
        if (performance.now() - start > capMs)
          throw new Error("Timed out waiting on the component");
        await frame();
      }
    };
    return { root: r, frame, until, pointer: (el) => pointerOn(el, pointerId) };
  };

  const drive = async (g: number, index: number) => {
    const ctx = contextFor(g);
    await keep.current.reset(ctx);
    return keep.current.moments[index]!.run(ctx);
  };

  useEffect(() => {
    alive.current = true;
    const g = ++generation.current;
    const prepare = async () => {
      setReady(false);
      setError(false);
      try {
        await document.fonts.ready;
        const shots: StateSnapshot[] = [];
        for (let i = 0; i < keep.current.moments.length; i++) {
          const { time } = await drive(g, i);
          shots.push(...captureEach(root.current!, 1, () => time));
        }
        const { held } = await drive(g, hero);
        setSnapshots(oneCamera(shots));
        setM(held);
        setSelected(hero);
        setReady(true);
      } catch (e) {
        if (e instanceof Gone) return;
        if (import.meta.env.DEV) console.warn("Spec capture failed:", e);
        setError(true);
      }
    };
    void prepare();
    const refresh = () => setAttempt((v) => v + 1);
    window.addEventListener("spec-theme", refresh);
    return () => {
      alive.current = false;
      generation.current++;
      window.removeEventListener("spec-theme", refresh);
    };
  }, [attempt, hero]);

  const select = (i: number) => {
    const g = ++generation.current;
    setSelected(i);
    drive(g, i)
      .then(({ held }) => {
        if (g === generation.current) setM(held);
      })
      .catch((e) => {
        if (!(e instanceof Gone) && import.meta.env.DEV) console.warn("Spec moment failed:", e);
      });
  };

  return {
    root,
    m,
    ready,
    error,
    retry: () => setAttempt((v) => v + 1),
    snapshots,
    selected,
    select,
  };
}

/**
 * Presses `el` at its centre and moves the pointer along one axis, a few px a
 * frame, in the list's own px (`scale`: screen px per list px). Travel is
 * the pointer's, from where it was pressed.
 */
export function press(ctx: RunContext, el: Element, axis: "x" | "y", scale: number) {
  const from = centreOf(el);
  const pointer = ctx.pointer(el);
  pointer.down(from.x, from.y);
  let travel = 0;
  const at = (t: number) =>
    axis === "x"
      ? ([from.x + t * scale, from.y] as const)
      : ([from.x, from.y + t * scale] as const);
  const step = async (direction: number, size: number) => {
    travel += direction * size;
    pointer.move(...at(travel));
    await ctx.frame();
  };
  return {
    get travel() {
      return travel;
    },
    /** Moves to `target` travel. */
    async to(target: number, size = 4) {
      while (Math.abs(target - travel) > 0.01) {
        await step(Math.sign(target - travel), Math.min(size, Math.abs(target - travel)));
      }
    },
    /** Moves on until `done()` holds (it is waited for, never assumed), at most `cap` px. */
    async until(done: () => boolean, direction: 1 | -1 = 1, cap = 600, size = 2) {
      const start = travel;
      while (!done()) {
        if (Math.abs(travel - start) > cap) throw new Error("The drag never got there");
        await step(direction, size);
      }
    },
    up: () => pointer.up(...at(travel)),
  };
}
