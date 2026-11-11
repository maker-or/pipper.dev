import { useState } from "react";
import type { Project } from "../../../contracts/projects.ts";
import { DRAG_ACTIVATION_PX, EDGE_ELASTIC } from "@/components/drag-reorder";
import { ProjectRail } from "@/components/project-rail";
import { DEFAULT_TAB_REORDER } from "@/lib/tab-reorder";
import {
  Callout,
  markClass,
  Moments,
  Overlay,
  r1,
  SpecPage,
  Timeline,
  U,
  useCrisp,
  Ut,
  VDim,
  within,
} from "../kit/spec-kit";
import { press, useGestureSpec, type Moment, type RunContext } from "./gesture-driver";
import { ScaledSubject, TravelMapping, untilStill } from "./figures";

// The project rail mid-drag. A tile is 82px but its slot is the rail's height shared by 5–6 tiles, so the drag
// counts the whole slot: the swap comes 45% of a slot in, and neighbours move a whole slot, keeping the gaps even.

const PROJECTS: Project[] = [
  { id: "omni", name: "omni", path: "/omni", icon: "circle" },
  { id: "landing", name: "landing", path: "/landing", icon: "arch" },
  { id: "writing", name: "writing", path: "/writing", icon: "square" },
  { id: "inter", name: "inter", path: "/inter", icon: "oval" },
];
// The rail's size in the app at a 1280 × 800 window (measured there: 6 slots of about 123px); the fixture is held to
// it so the slots come out the same.
const RAIL = { w: 80, h: 740 };
const Z = 0.5;
const { threshold: SWAP_AT } = DEFAULT_TAB_REORDER;

type Box = { x: number; y: number; w: number; h: number };
type Held = {
  travel: number;
  /** Pointer travel when the drag picked the tile up (it moves 1:1 from there). */
  pickup: number;
  tileTravel: number;
  slot: number;
  tile: number;
  held: Box;
  heldTile: Box;
  start: Box;
  neighbour: Box;
  neighbourTile: Box;
  rail: { w: number; h: number };
  order: string[];
  scale: number;
};

export function RailPoster({ theme }: { theme: "light" | "dark" }) {
  const [projects, setProjects] = useState(PROJECTS);
  const item = (root: HTMLElement, id: string) =>
    root.querySelector<HTMLElement>(`[data-drag-item="${id}"]`)!;
  const tileOf = (el: HTMLElement) =>
    el.querySelector<HTMLElement>('[data-pipper-id="project-tile"]')!;
  const scroller = (root: HTMLElement) => item(root, "omni").parentElement!;

  // presses the first tile and drives it; `then` moves it on from there. Held at the end.
  const drag = async (
    ctx: RunContext,
    then: (p: ReturnType<typeof press>) => Promise<void>,
  ): Promise<Held> => {
    const a = item(ctx.root, "omni");
    const list = scroller(ctx.root);
    const s = list.getBoundingClientRect().height / list.offsetHeight;
    const start = within(ctx.root, a);
    const p = press(ctx, a, "y", s);
    // (the drag starts once the pointer has moved 6 screen px: the tile follows from there)
    const direction = then === pastTop ? -1 : 1;
    await p.until(() => a.hasAttribute("data-held"), direction);
    const pickup = p.travel;
    await then(p);
    await untilStill(ctx, () => [item(ctx.root, "landing")]);
    const held = within(ctx.root, a);
    const b = item(ctx.root, "landing");
    return {
      travel: p.travel,
      pickup,
      tileTravel: r1(held.y + held.h / 2 - (start.y + start.h / 2)),
      slot: a.offsetHeight,
      tile: tileOf(a).offsetHeight,
      held,
      heldTile: within(ctx.root, tileOf(a)),
      start,
      neighbour: within(ctx.root, b),
      neighbourTile: within(ctx.root, tileOf(b)),
      rail: { w: ctx.root.offsetWidth, h: ctx.root.offsetHeight },
      order: [...list.querySelectorAll<HTMLElement>("[data-drag-item]")].map(
        (el) => el.dataset.dragItem!,
      ),
      scale: r1(new DOMMatrixReadOnly(getComputedStyle(a).transform).d * 100) / 100,
    };
  };
  const swapped = (ctx: RunContext) => () =>
    scroller(ctx.root).querySelector<HTMLElement>("[data-drag-item]")?.dataset.dragItem !== "omni";

  // 60px of pointer past the top of the free run
  const pastTop = (p: ReturnType<typeof press>) => p.to(p.travel - 60);

  const moments: Moment<Held>[] = [
    {
      label: "Picked up",
      run: async (ctx) => {
        const held = await drag(ctx, (p) => p.to(p.travel + 8));
        return { held, time: held.travel };
      },
    },
    {
      label: "Swapped",
      run: async (ctx) => {
        const held = await drag(ctx, async (p) => {
          await p.until(swapped(ctx));
          await p.to(p.travel + 2);
        });
        return { held, time: held.travel };
      },
    },
    {
      label: "Past the top",
      run: async (ctx) => {
        const held = await drag(ctx, pastTop);
        return { held, time: held.travel };
      },
    },
  ];

  const reset = async (ctx: RunContext) => {
    // (always: a run cut short may have left this poster's pointer pressed)
    ctx.pointer(item(ctx.root, "omni")).cancel();
    await ctx.until(() => !ctx.root.querySelector("[data-drag-item][data-held]"));
    setProjects(PROJECTS);
    await untilStill(ctx, () => [...ctx.root.querySelectorAll("[data-drag-item]")]);
  };

  const drv = useGestureSpec<Held>({ moments, hero: 1, reset });
  const m = drv.m;
  const reach = m ? m.slot * (PROJECTS.length - 1) : 1;
  return (
    <SpecPage
      accent="rail-slot"
      theme={theme}
      label="Project rail drag specification"
      name="Project rail: a tile counts as its whole slot"
      ready={drv.ready}
      error={drv.error}
      onRetry={drv.retry}
      lines={["now", "start", "target"]}
      drawing={
        <>
          <ScaledSubject z={Z} root={drv.root}>
            {/* (on the shell's own surface, as in the app: shapes rest in that colour) */}
            <div
              className="flex flex-col bg-surface-1 px-2"
              style={{ width: RAIL.w, height: RAIL.h }}
            >
              <ProjectRail
                projects={projects}
                onProjectsChange={setProjects}
                selectedId="omni"
                tone="neutral"
                onOpen={() => {}}
                onDelete={() => {}}
              />
            </div>
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
            crop={{ x: 0, y: 0, w: RAIL.w, h: m.slot * 2.2 }}
            height={89}
            timeline={
              <Timeline
                value={Math.max(0, m.travel)}
                max={Math.ceil(m.slot)}
                f={(v) => v / Math.ceil(m.slot)}
                marks={drv.snapshots.map((shot) => Math.max(0, shot.time))}
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
                head: "The slot, not the tile, is the unit.",
                body: (
                  <>
                    The tile is {m.tile}px; its slot is {r1(m.slot)}px, the rail's height shared by
                    5–6. The swap comes {Math.round(SWAP_AT * 100)}% of a slot in:{" "}
                    {r1(SWAP_AT * m.slot)}px.
                  </>
                ),
              },
              {
                part: "n2",
                head: "Neighbours move a whole slot.",
                body: (
                  <>
                    So the gaps stay even through the drag, the same spacing the rail keeps at rest.
                  </>
                ),
              },
              {
                part: "n3",
                head: "The ends push back.",
                body:
                  m.tileTravel < 0 ? (
                    <>
                      Past either end the tile moves {EDGE_ELASTIC}× the pointer:{" "}
                      {r1(m.pickup - m.travel)}px past the top moves it {r1(-m.tileTravel)}px.
                    </>
                  ) : (
                    <>
                      Past either end the tile moves {EDGE_ELASTIC}× the pointer. Here it is in the
                      list, moving 1:1: {r1(m.tileTravel)}px since pickup.
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
              ["Tracks", "transform: translateY, per pointermove", "none"],
              [
                "Tile / slot",
                <>
                  <U v={m.tile} u="px" /> in <U v={r1(m.slot)} u="px" />
                </>,
                "n1",
              ],
              [
                "Swap",
                <>
                  <U v={r1(SWAP_AT * m.slot)} u="px" /> ({Math.round(SWAP_AT * 100)}% of a slot)
                </>,
                "n1",
              ],
              ["Ends", <>{EDGE_ELASTIC}× the pointer</>, "n3"],
              ["Held tile", <>{Math.round(m.scale * 100)}% scale</>, "none"],
              ["Release", "Same spring as the tab bar", "none"],
              ["Reduced motion", "Tracking unchanged; no lift scale", "none"],
            ]
          : []
      }
      fig2={
        m
          ? {
              node: (
                <TravelMapping
                  input={m.travel - m.pickup}
                  min={0}
                  max={reach}
                  elastic={EDGE_ELASTIC}
                  span={120}
                />
              ),
            }
          : undefined
      }
      units={`Dimensions in px at 1×, drawn at ${Z}×. Rail fixture ${RAIL.w} × ${RAIL.h}`}
    />
  );
}

function Drawing({ m }: { m: Held }) {
  const { ref, snap } = useCrisp();
  const s = (v: number) => v * Z;
  const W = s(m.rail.w);
  const H = s(m.rail.h);
  const start = { x: s(m.start.x), y: s(m.start.y), w: s(m.start.w), h: s(m.start.h) };
  const nb = { x: s(m.neighbour.x), y: s(m.neighbour.y), w: s(m.neighbour.w), h: s(m.neighbour.h) };
  const nbTile = { y: s(m.neighbourTile.y), h: s(m.neighbourTile.h) };
  const tile = { x: s(m.heldTile.x), y: s(m.heldTile.y), w: s(m.heldTile.w), h: s(m.heldTile.h) };
  return (
    <Overlay w={W} h={H} svgRef={ref}>
      {/* the held tile's own slot at rest */}
      <rect x={start.x} y={start.y} width={start.w} height={start.h} className={markClass.ghost} />
      {/* the neighbour's slot (and, inside it, its tile): the unit the drag counts */}
      <VDim
        snap={snap}
        y1={nb.y}
        y2={nb.y + nb.h}
        x={W + 21}
        from={W}
        label={r1(m.slot)}
        part="n1"
      />
      <VDim
        snap={snap}
        y1={nbTile.y}
        y2={nbTile.y + nbTile.h}
        x={-21}
        from={0}
        label={m.tile}
        left
        part="n1"
      />
      <Callout n={1} x={W} y={nb.y + nb.h * 0.85} dir="se" />
      <Callout n={2} x={0} y={nb.y + nb.h * 0.1} dir="nw" len={21} />
      <Callout n={3} x={tile.x + tile.w} y={tile.y} dir="ne" />
    </Overlay>
  );
}
