import { useRef } from "react";
import { spring, type Transition } from "framer-motion";
import { RELEASE_SPRING_REDUCED } from "@/components/drag-reorder";
import {
  Callout,
  Curve,
  Dim,
  markClass,
  Moments,
  Overlay,
  overshoot,
  r1,
  SpecPage,
  Timeline,
  U,
  useCrisp,
  Ut,
  within,
} from "../kit/spec-kit";
import { press, useGestureSpec, type Moment, type RunContext } from "./gesture-driver";
import { ScaledSubject, untilStill } from "./figures";
import { TabStripSubject, type TabStripController } from "./tab-strip-subject";

// The global tab bar just after a drop: the tab springs from where it was let go into its slot, starting at the
// pointer's speed. Held part way through the spring.

type Box = { x: number; y: number; w: number; h: number };
type Held = {
  elapsed: number;
  duration: number;
  from: number;
  offset: number;
  velocity: number;
  transition: Transition;
  tab: Box;
  slot: Box;
  strip: { w: number; h: number };
};

const Z = 1.5;
const FRACTIONS = [0, 0.2, 1] as const;

/** The spring the hook started, as framer-motion runs it, sampled without moving it. */
function springCurve(m: Pick<Held, "from" | "velocity" | "transition">) {
  const generator = spring({
    ...(m.transition as object),
    keyframes: [m.from, 0],
    velocity: m.velocity,
  });
  // (progress: 0 at release, 1 at the slot; past 1 where it overshoots)
  return (ms: number) => (m.from === 0 ? 1 : 1 - generator.next(ms).value / m.from);
}

export function TabReleasePoster({ theme }: { theme: "light" | "dark" }) {
  const controller = useRef<TabStripController | null>(null);
  const tab = (root: HTMLElement, id: string) =>
    root.querySelector<HTMLElement>(`[data-drag-item="${id}"]`)!;

  // drags the first tab past its neighbour at a steady few px a frame, lets go, and holds the spring at `fraction`
  const releaseAt = async (ctx: RunContext, fraction: number) => {
    const c = controller.current!;
    const a = tab(ctx.root, "auth");
    const list = c.list!;
    const s = list.getBoundingClientRect().width / list.offsetWidth;
    const p = press(ctx, a, "x", s);
    // a steady 12px a frame throughout, so the release has a real speed
    await p.until(() => controller.current!.reorder.order[0] === "rail", 1, 600, 12);
    // on past the swap, then let go mid-move
    await p.to(p.travel + 24, 12);
    p.up();
    await ctx.until(() => c.reorder.settleOf("auth") !== null);
    await ctx.frame();
    const info = controller.current!.reorder.settleOf("auth")!;
    info.controls.pause();
    const duration = info.controls.duration * 1000;
    info.controls.time = (duration * fraction) / 1000;
    // (the neighbour finishes its own slide; only the dropped tab is held)
    await untilStill(ctx, () => [tab(ctx.root, "rail")]);
    const tabEl = tab(ctx.root, "auth");
    const offset = r1(controller.current!.reorder.offsetFor("auth").get());
    const now = within(ctx.root, tabEl);
    const held: Held = {
      elapsed: Math.round(duration * fraction),
      duration: Math.round(duration),
      from: r1(info.from),
      offset,
      velocity: Math.round(info.velocity),
      transition: info.transition,
      tab: now,
      slot: { ...now, x: r1(now.x - offset) },
      strip: { w: ctx.root.offsetWidth, h: ctx.root.offsetHeight },
    };
    return { held, time: held.elapsed };
  };

  const moments: Moment<Held>[] = [
    { label: "Released", run: (ctx) => releaseAt(ctx, FRACTIONS[0]) },
    { label: "Mid-flight", run: (ctx) => releaseAt(ctx, FRACTIONS[1]) },
    { label: "Settled", run: (ctx) => releaseAt(ctx, FRACTIONS[2]) },
  ];

  const reset = async (ctx: RunContext) => {
    const c = controller.current!;
    const info = c.reorder.settleOf("auth");
    if (info) info.controls.complete();
    // (always: a run cut short may have left this poster's pointer pressed)
    ctx.pointer(tab(ctx.root, "auth")).cancel();
    await ctx.until(() => controller.current!.reorder.liftedIds.length === 0);
    c.resetOrder();
    await untilStill(ctx, () => [tab(ctx.root, "auth"), tab(ctx.root, "rail")]);
  };

  const drv = useGestureSpec<Held>({ moments, hero: 1, reset });
  const m = drv.m;
  const curve = m ? springCurve(m) : () => 0;
  const past = m ? overshoot(curve, m.duration) : 0;
  const config = (m?.transition ?? {}) as { visualDuration?: number; bounce?: number };
  const reduced = RELEASE_SPRING_REDUCED as { visualDuration?: number; bounce?: number };
  return (
    <SpecPage
      accent="tab-release"
      theme={theme}
      label="Tab release specification"
      name="Global tab bar: let go, and it springs home at your speed"
      ready={drv.ready}
      error={drv.error}
      onRetry={drv.retry}
      lines={["now", "start", "target"]}
      drawing={
        <>
          <ScaledSubject z={Z} root={drv.root}>
            <TabStripSubject controller={controller} />
          </ScaledSubject>
          {m && <Drawing m={m} />}
        </>
      }
      moments={
        m && (
          <Moments
            snapshots={drv.snapshots}
            labels={moments.map((moment) => moment.label)}
            selected={drv.selected}
            onSelect={drv.select}
            timeline={
              <Timeline
                value={m.elapsed}
                max={m.duration}
                f={(ms) => Math.min(1.15, curve(ms))}
                marks={FRACTIONS.map((f) => f * m.duration)}
                selected={drv.selected}
                label={<Ut v={m.elapsed} u="ms" />}
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
                head: "It leaves at your speed.",
                body: (
                  <>
                    Let go {r1(Math.abs(m.from))}px from its slot, moving at {Math.abs(m.velocity)}
                    px/s. The spring starts with that velocity, so a flick and a gentle drop land
                    differently.
                  </>
                ),
              },
              {
                part: "n2",
                head: "A spring, not a tween.",
                body: (
                  <>
                    It overshoots its slot by {r1(past * Math.abs(m.from))}px and is at rest after{" "}
                    {m.duration}ms, when framer-motion calls it settled.
                  </>
                ),
              },
              {
                part: "n3",
                head: "It can be caught.",
                body: (
                  <>
                    Pressing it in flight stops the spring and picks it up where it is,{" "}
                    {r1(Math.abs(m.offset))}px out now.
                  </>
                ),
              },
            ]
          : []
      }
      spec={
        m
          ? [
              ["Trigger", "Pointer up after a drag", "none"],
              ["Animates", "transform: translateX → 0", "n2"],
              [
                "Spring",
                <>
                  visual duration <U v={config.visualDuration} u="s" />, bounce {config.bounce}
                </>,
                "curve",
              ],
              [
                "Seeded with",
                <>
                  <U v={m.velocity} u="px/s" /> (release velocity)
                </>,
                "n1",
              ],
              ["At rest", <U v={m.duration} u="ms" />, "curve"],
              ["Overshoot", <U v={r1(past * Math.abs(m.from))} u="px" />, "n2"],
              ["Interrupt", "Press mid-flight to catch it", "n3"],
              [
                "Reduced motion",
                <>
                  no velocity, <U v={reduced.visualDuration} u="s" />, bounce {reduced.bounce}
                </>,
                "none",
              ],
            ]
          : []
      }
      fig2={
        m
          ? {
              node: (
                <Curve
                  x={m.elapsed}
                  max={m.duration}
                  series={[{ f: curve }]}
                  end={<Ut v={m.duration} u="ms" />}
                  unit="ms"
                  marks={FRACTIONS.map((f) => f * m.duration)}
                />
              ),
            }
          : undefined
      }
      units={`Dimensions in px at 1×, drawn at ${Z}×. Curve sampled from framer-motion's spring()`}
    />
  );
}

function Drawing({ m }: { m: Held }) {
  const { ref, snap } = useCrisp();
  const s = (v: number) => v * Z;
  const W = s(m.strip.w);
  const H = s(m.strip.h);
  const tab = { x: s(m.tab.x), y: s(m.tab.y), w: s(m.tab.w), h: s(m.tab.h) };
  const slot = { x: s(m.slot.x), y: s(m.slot.y), w: s(m.slot.w), h: s(m.slot.h) };
  const release = { ...slot, x: s(m.slot.x + m.from) };
  return (
    <Overlay w={W} h={H} svgRef={ref}>
      {/* where it was let go */}
      <rect
        x={release.x}
        y={release.y}
        width={release.w}
        height={release.h}
        rx={s(8)}
        className={markClass.ghost}
      />
      {/* the slot it springs into */}
      <rect
        x={slot.x}
        y={slot.y}
        width={slot.w}
        height={slot.h}
        rx={s(8)}
        className={markClass.reference}
      />
      {Math.abs(m.offset) > 1 && (
        <Dim
          snap={snap}
          x1={Math.min(slot.x, tab.x)}
          x2={Math.max(slot.x, tab.x)}
          y={H + 21}
          from={H}
          label={r1(Math.abs(m.offset))}
          below
          part="n3"
        />
      )}
      <Callout n={1} x={release.x + release.w} y={release.y} dir="ne" />
      <Callout n={2} x={slot.x} y={slot.y} dir="nw" />
      <Callout n={3} x={tab.x + tab.w * 0.5} y={tab.y} dir="ne" len={21} />
    </Overlay>
  );
}
