import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import styles from "../kit/spec.module.css";
import { Ut, r1 } from "../kit/spec-kit";
import type { RunContext } from "./gesture-driver";

/** A figure drawn at its column's own width, 1:1, so its words stay 12px. */
function useColumnWidth(fallback = 229) {
  const svg = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const cw = svg.current?.parentElement?.clientWidth;
    if (cw && Math.abs(cw - w) > 0.5) setW(cw);
  });
  return { svg, w };
}

/**
 * Figure 2 for the swap: where the held tab's overlap with its neighbour
 * decides. Moving on, it swaps at `swapAt`; once swapped, it only swaps back
 * below `undoAt`. The current overlap sits on the row that applies now.
 */
export function SwapRegions({
  overlap,
  swapped,
  swapAt,
  undoAt,
}: {
  /** Overlap as a fraction of the narrower tab. */
  overlap: number;
  swapped: boolean;
  swapAt: number;
  undoAt: number;
}) {
  const { svg, w } = useColumnWidth();
  const lo = -0.2;
  const hi = 1;
  const L = 8;
  const W = w - L - 8;
  const X = (v: number) => L + (W * (Math.max(lo, Math.min(hi, v)) - lo)) / (hi - lo);
  const rowH = 21;
  const rows = [
    { y: 21, label: "Moving on", cut: swapAt, before: "holds", after: "swaps", hot: "after" },
    {
      y: 77,
      label: "After a swap",
      cut: undoAt,
      before: "swaps back",
      after: "holds",
      hot: "before",
    },
  ] as const;
  const active = swapped ? 1 : 0;
  const cx = X(overlap);
  return (
    <svg
      ref={svg}
      className={styles.curve}
      viewBox={`0 0 ${w} 140`}
      role="img"
      aria-label={`Overlap ${Math.round(overlap * 100)} percent; ${swapped ? "swapped" : "not swapped"}.`}
    >
      {rows.map((row, i) => (
        <g key={row.label}>
          <text x={L} y={row.y - 6}>
            {row.label}
          </text>
          <rect
            x={X(lo)}
            y={row.y}
            width={X(row.cut) - X(lo)}
            height={rowH}
            className={row.hot === "before" ? styles.bandOn : styles.band}
          />
          <rect
            x={X(row.cut)}
            y={row.y}
            width={X(hi) - X(row.cut)}
            height={rowH}
            className={row.hot === "after" ? styles.bandOn : styles.band}
          />
          <line
            x1={X(row.cut)}
            x2={X(row.cut)}
            y1={row.y - 3}
            y2={row.y + rowH + 3}
            className={styles.referenceLine}
          />
          <text x={(X(lo) + X(row.cut)) / 2} y={row.y + 15} textAnchor="middle">
            {row.before}
          </text>
          <text x={(X(row.cut) + X(hi)) / 2} y={row.y + 15} textAnchor="middle">
            {row.after}
          </text>
          {i === active && (
            <>
              <line
                x1={cx}
                x2={cx}
                y1={row.y - 3}
                y2={row.y + rowH + 3}
                className={styles.playhead}
              />
              <circle cx={cx} cy={row.y + rowH + 3} r={3.5} className={styles.dot} />
            </>
          )}
        </g>
      ))}
      <path d={`M${X(lo)} 118H${X(hi)}`} className={styles.axis} />
      {[0, undoAt, swapAt, 1].map((v) => (
        <g key={v}>
          <line x1={X(v)} x2={X(v)} y1={118} y2={122} className={styles.axis} />
          <text
            x={X(v)}
            y={135}
            textAnchor={v === undoAt ? "end" : v === swapAt ? "start" : "middle"}
          >
            <Ut v={Math.round(v * 100)} u="%" />
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * Figure 2 for the rail: pointer travel in, tile travel out. Inside the list
 * the tile goes where the pointer goes; past either end it goes `elastic` of
 * the way. The current input is marked on it.
 */
export function TravelMapping({
  input,
  min,
  max,
  elastic,
  span,
}: {
  input: number;
  /** Ends of the free run, in pointer travel. */
  min: number;
  max: number;
  elastic: number;
  /** How far past each end the figure reaches. */
  span: number;
}) {
  const { svg, w } = useColumnWidth();
  const out = (v: number) =>
    v < min ? min - (min - v) * elastic : v > max ? max + (v - max) * elastic : v;
  const x0 = min - span;
  const x1 = max + span;
  const y0 = out(x0);
  const y1 = out(x1);
  const L = 34;
  const T = 8;
  const W = w - L - 8;
  const H = 117;
  const X = (v: number) => L + (W * (v - x0)) / (x1 - x0);
  const Y = (v: number) => T + (H * (y1 - v)) / (y1 - y0);
  const path = Array.from({ length: 121 }, (_, i) => {
    const v = x0 + ((x1 - x0) * i) / 120;
    return `${i ? "L" : "M"}${X(v)} ${Y(out(v))}`;
  }).join("");
  const cx = X(Math.max(x0, Math.min(x1, input)));
  const cy = Y(out(Math.max(x0, Math.min(x1, input))));
  return (
    <svg
      ref={svg}
      className={styles.curve}
      viewBox={`0 0 ${w} ${T + H + 21}`}
      role="img"
      aria-label={`Pointer ${r1(input)} px, tile ${r1(out(input))} px.`}
    >
      <path d={`M${L} ${T}V${T + H}H${L + W}`} className={styles.axis} />
      <line x1={X(x0)} y1={Y(x0)} x2={X(x1)} y2={Y(x1)} className={styles.referenceLine} />
      <path d={`M${X(min)} ${T}V${T + H}M${X(max)} ${T}V${T + H}`} className={styles.guide} />
      <path d={path} className={styles.ease} />
      <circle cx={cx} cy={cy} r={3.5} className={styles.dot} />
      <text x={L - 6} y={Y(max) + 4} textAnchor="end">
        {Math.round(max)}
      </text>
      <text x={L - 6} y={Y(min) + 4} textAnchor="end">
        {Math.round(min)}
      </text>
      <text x={X(min)} y={T + H + 17} textAnchor="middle">
        {Math.round(min)}
      </text>
      <text x={X(max)} y={T + H + 17} textAnchor="middle">
        {Math.round(max)}
      </text>
      {/* (inside the free run, below and right of the point, where the 1:1 reference runs above it; past an end,
          in the plot's empty top-left corner, clear of the axis labels and guides near the point) */}
      <text
        x={input < min || input > max ? L + 8 : cx + 8}
        y={input < min || input > max ? T + 12 : cy + 15}
        textAnchor="start"
        className={styles.accentText}
      >
        <Ut v={r1(out(input))} u="px" />
      </text>
    </svg>
  );
}

/**
 * The subject at a fixed drawing scale, in a box the size of its scaled
 * footprint (a transform, not CSS zoom: framer-motion's layout animations
 * and the drag hook both read layout px).
 */
export function ScaledSubject({
  z,
  root,
  children,
}: {
  z: number;
  root: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const read = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  return (
    <div className={styles.subject} style={{ width: size.w * z, height: size.h * z }}>
      <div style={{ transform: `scale(${z})`, transformOrigin: "0 0", width: "max-content" }}>
        <div ref={root} style={{ display: "inline-block" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Waits until each element's box has held still for three frames (layout springs done). */
export async function untilStill(ctx: RunContext, elements: () => Element[]) {
  let last = "";
  let same = 0;
  await ctx.until(() => {
    const now = elements()
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${r1(r.left)},${r1(r.top)},${r1(r.width)}`;
      })
      .join("|");
    same = now === last ? same + 1 : 0;
    last = now;
    return same >= 3;
  });
}
