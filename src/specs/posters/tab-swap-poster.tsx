import { useRef } from "react";
import { DRAG_ACTIVATION_PX, DRAG_LAYOUT_SPRING } from "@/components/drag-reorder";
import { DEFAULT_TAB_REORDER } from "@/lib/tab-reorder";
import {
  Callout,
  Dim,
  markClass,
  Moments,
  Overlay,
  r1,
  SpecPage,
  Timeline,
  U,
  useCrisp,
  Ut,
  within,
} from "../kit/spec-kit";
import { press, useGestureSpec, type Moment, type RunContext } from "./gesture-driver";
import { ScaledSubject, SwapRegions, untilStill } from "./figures";
import { TabStripSubject, type TabStripController } from "./tab-strip-subject";

// The global tab bar mid-drag: the held tab follows the pointer and its neighbour swaps once the held tab is 45% of
// the narrower tab into it. Held just past that point.

type Box = { x: number; y: number; w: number; h: number };
type Held = {
  travel: number;
  /** How far the tab itself has moved: it starts once the pointer has gone 6 screen px. */
  tabTravel: number;
  held: Box;
  start: Box;
  neighbourStart: Box;
  neighbour: Box;
  strip: { w: number; h: number };
  narrower: number;
  overlap: number;
  swapped: boolean;
  scale: number;
};

// Drawing scale: the strip at 1.5× fills the poster's width.
const Z = 1.5;
// (the swap rule's own constants, from src/lib/tab-reorder.ts: the component can't report them at runtime)
const { threshold: SWAP_AT, hysteresis: UNDO_BY } = DEFAULT_TAB_REORDER;

export function TabSwapPoster({ theme }: { theme: "light" | "dark" }) {
  const controller = useRef<TabStripController | null>(null);
  const tab = (root: HTMLElement, id: string) =>
    root.querySelector<HTMLElement>(`[data-drag-item="${id}"]`)!;

  // the drag's geometry at rest, in the strip's own px
  const geometry = (root: HTMLElement) => {
    const a = tab(root, "auth");
    const b = tab(root, "rail");
    const list = controller.current!.list!;
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    const narrower = Math.min(a.offsetWidth, b.offsetWidth);
    return { a, b, gap, narrower, s: list.getBoundingClientRect().width / list.offsetWidth };
  };

  const read = (root: HTMLElement, travel: number, start: Box, neighbourStart: Box): Held => {
    const a = tab(root, "auth");
    const b = tab(root, "rail");
    const held = within(root, a);
    const narrower = Math.min(a.offsetWidth, b.offsetWidth);
    // the held tab's layout box (its transform has a lift scale about its centre)
    const right = held.x + held.w / 2 + a.offsetWidth / 2;
    return {
      travel,
      tabTravel: r1(held.x + held.w / 2 - (start.x + start.w / 2)),
      held,
      start,
      neighbourStart,
      neighbour: within(root, b),
      strip: { w: root.offsetWidth, h: root.offsetHeight },
      narrower,
      overlap: r1(right - neighbourStart.x),
      swapped:
        controller.current!.order[0] === "rail" || controller.current!.reorder.order[0] === "rail",
      scale: r1(new DOMMatrixReadOnly(getComputedStyle(a).transform).a * 100) / 100,
    };
  };

  // presses the first tab and drives it; `then` moves it on from there. Held at the end.
  const drag = async (ctx: RunContext, then: (p: ReturnType<typeof press>) => Promise<void>) => {
    const { a, s } = geometry(ctx.root);
    const start = within(ctx.root, a);
    const neighbourStart = within(ctx.root, tab(ctx.root, "rail"));
    const p = press(ctx, a, "x", s);
    await then(p);
    await untilStill(ctx, () => [tab(ctx.root, "rail")]);
    return read(ctx.root, p.travel, start, neighbourStart);
  };
  const lifted = () => controller.current!.reorder.heldId === "auth";
  const swapped = () => controller.current!.reorder.order[0] === "rail";

  const moments: Moment<Held>[] = [
    {
      label: "Picked up",
      run: async (ctx) => {
        const held = await drag(ctx, async (p) => {
          await p.until(lifted);
          await p.to(p.travel + 6);
        });
        return { held, time: held.travel };
      },
    },
    {
      label: "Swapped",
      run: async (ctx) => {
        const held = await drag(ctx, async (p) => {
          await p.until(swapped);
          await p.to(p.travel + 2);
        });
        return { held, time: held.travel };
      },
    },
    {
      label: "Pulled back",
      run: async (ctx) => {
        const { narrower } = geometry(ctx.root);
        const held = await drag(ctx, async (p) => {
          await p.until(swapped);
          // back by less than the undo margin: the order holds
          await p.to(p.travel - Math.floor(UNDO_BY * narrower * 0.7));
        });
        return { held, time: held.travel };
      },
    },
  ];

  const reset = async (ctx: RunContext) => {
    const c = controller.current!;
    // (always: a run cut short may have left this poster's pointer pressed)
    ctx.pointer(tab(ctx.root, "auth")).cancel();
    await ctx.until(() => controller.current!.reorder.liftedIds.length === 0);
    c.resetOrder();
    await untilStill(ctx, () => [tab(ctx.root, "auth"), tab(ctx.root, "rail")]);
  };

  const drv = useGestureSpec<Held>({ moments, hero: 1, reset });
  const m = drv.m;
  const swapRight = m ? m.neighbourStart.x + SWAP_AT * m.narrower : 0;
  const maxTravel = m ? Math.ceil(m.neighbourStart.x - m.start.x + m.narrower) : 1;
  return (
    <SpecPage
      accent="tab-swap"
      theme={theme}
      label="Tab drag specification"
      name="Global tab bar: the tab is the pointer"
      ready={drv.ready}
      error={drv.error}
      onRetry={drv.retry}
      lines={["now", "start", "target"]}
      drawing={
        <>
          <ScaledSubject z={Z} root={drv.root}>
            <TabStripSubject controller={controller} />
          </ScaledSubject>
          {m && <Drawing m={m} swapRight={swapRight} />}
        </>
      }
      moments={
        m && (
          <Moments
            snapshots={drv.snapshots}
            labels={moments.map((moment) => moment.label)}
            selected={drv.selected}
            onSelect={drv.select}
            // (the two tabs that trade places)
            crop={{
              x: 0,
              y: 0,
              w: Math.ceil(m.neighbourStart.x + m.neighbourStart.w + 8),
              h: m.strip.h,
            }}
            timeline={
              <Timeline
                value={Math.max(0, m.travel)}
                max={maxTravel}
                f={(v) => v / maxTravel}
                marks={drv.snapshots.map((shot) => shot.time)}
                selected={drv.selected}
                label={<Ut v={r1(m.travel)} u="px" />}
              />
            }
          />
        )
      }
      notes={
        m
          ? [
              {
                part: "n1",
                head: "The tab is the pointer.",
                body: (
                  <>
                    Each pointer move writes its offset straight to its transform: no spring, no
                    render. It has moved {r1(m.tabTravel)}px, lifted to {Math.round(m.scale * 100)}
                    %.
                  </>
                ),
              },
              {
                part: "n2",
                head: "The neighbour slides, the tab doesn't.",
                body: (
                  <>
                    Once swapped, the neighbour moves to the free slot on a layout spring. Only the
                    held tab skips layout animation, so it never trails.
                  </>
                ),
              },
              {
                part: "n3",
                head: `Swap at ${Math.round(SWAP_AT * 100)}%, undo ${Math.round(UNDO_BY * 100)}% further back.`,
                body: (
                  <>
                    Measured against the narrower tab ({m.narrower}px). Now {r1(m.overlap)}px in, so
                    a wobble on the line never flickers the order.
                  </>
                ),
              },
            ]
          : []
      }
      spec={
        m
          ? [
              [
                "Trigger",
                <>
                  Press, then move <U v={DRAG_ACTIVATION_PX} u="px" />
                </>,
                "none",
              ],
              ["Tracks", "transform: translateX, per pointermove", "n1"],
              ["Held tab", <>{Math.round(m.scale * 100)}% scale, raised surface</>, "n1"],
              ["Swap", <>{Math.round(SWAP_AT * 100)}% of the narrower tab</>, "n3"],
              ["Undo", <>back {Math.round(UNDO_BY * 100)}% past the swap</>, "n3"],
              [
                "Neighbours",
                <>
                  spring {DRAG_LAYOUT_SPRING.stiffness} / {DRAG_LAYOUT_SPRING.damping} /{" "}
                  {DRAG_LAYOUT_SPRING.mass}
                </>,
                "n2",
              ],
              ["Escape", "Order restored, nothing saved", "none"],
              ["Reduced motion", "Tracking unchanged; no lift scale", "none"],
            ]
          : []
      }
      fig2={
        m
          ? {
              node: (
                <SwapRegions
                  overlap={m.overlap / m.narrower}
                  swapped={m.swapped}
                  swapAt={SWAP_AT}
                  undoAt={SWAP_AT - UNDO_BY}
                />
              ),
            }
          : undefined
      }
      units={`Dimensions in px at 1×, drawn at ${Z}×. Swap and undo margins from src/lib/tab-reorder.ts`}
    />
  );
}

function Drawing({ m, swapRight }: { m: Held; swapRight: number }) {
  const { ref, snap } = useCrisp();
  const W = m.strip.w * Z;
  const H = m.strip.h * Z;
  const s = (v: number) => v * Z;
  const held = { x: s(m.held.x), y: s(m.held.y), w: s(m.held.w), h: s(m.held.h) };
  const start = { x: s(m.start.x), y: s(m.start.y), w: s(m.start.w), h: s(m.start.h) };
  const nb = { x: s(m.neighbour.x), y: s(m.neighbour.y), w: s(m.neighbour.w), h: s(m.neighbour.h) };
  const swapX = s(swapRight);
  return (
    <Overlay w={W} h={H} svgRef={ref}>
      {/* where the held tab started */}
      <rect
        x={start.x}
        y={start.y}
        width={start.w}
        height={start.h}
        rx={s(8)}
        className={markClass.ghost}
      />
      {/* the swap point: the held tab's right edge here swaps it */}
      <line x1={swapX} x2={swapX} y1={-13} y2={H + 13} className={markClass.reference} />
      <Dim
        snap={snap}
        x1={held.x}
        x2={held.x + held.w}
        y={-21}
        from={held.y}
        label={r1(m.held.w)}
        part="n1"
      />
      {/* (once it is well into the neighbour: a sliver isn't worth a dimension) */}
      {m.overlap > 0.25 * m.narrower && (
        <Dim
          snap={snap}
          x1={s(m.neighbourStart.x)}
          x2={s(m.neighbourStart.x + m.overlap)}
          y={H + 21}
          from={H}
          label={r1(m.overlap)}
          below
          part="n3"
        />
      )}
      <Callout n={1} x={held.x + held.w * 0.15} y={held.y} dir="nw" />
      <Callout n={2} x={nb.x + nb.w * 0.2} y={nb.y + nb.h} dir="sw" />
      <Callout n={3} x={swapX} y={-13} dir="ne" />
    </Overlay>
  );
}
