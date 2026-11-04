import type { ProjectShapeId } from "../../contracts/projects.ts";

/**
 * Outlines for the project shapes, after the Material 3 shape set. Each shape
 * is built as a dense polygon in its own units, then scaled and centred into
 * a 100×100 box, so every shape fills the same area wherever it's drawn.
 */

type Point = [x: number, y: number];

/** Side of the square every shape is fitted into, inside a 100 box. */
const FIT = 88;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Points along a circular arc; angles in radians, y pointing down. */
function arc(cx: number, cy: number, r: number, from: number, to: number): Point[] {
  const steps = Math.max(2, Math.ceil(Math.abs(to - from) / (TAU / 96)));
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    points.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return points;
}

/**
 * A polygon with circular corners. `radius` is per vertex (or one for all);
 * a corner never cuts more than its edges allow, so arcs given as runs of
 * radius-0 points can sit next to rounded corners. Concave corners round too.
 */
function rounded(vertices: Point[], radius: number | number[]): Point[] {
  const radii = vertices.map((_, i) => (typeof radius === "number" ? radius : (radius[i] ?? 0)));
  const out: Point[] = [];
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const v = vertices[i]!;
    const r = radii[i]!;
    if (r <= 0) {
      out.push(v);
      continue;
    }
    const prevIndex = (i - 1 + n) % n;
    const nextIndex = (i + 1) % n;
    const prev = vertices[prevIndex]!;
    const next = vertices[nextIndex]!;
    const toPrev: Point = [prev[0] - v[0], prev[1] - v[1]];
    const toNext: Point = [next[0] - v[0], next[1] - v[1]];
    const lenPrev = Math.hypot(...toPrev);
    const lenNext = Math.hypot(...toNext);
    const uPrev: Point = [toPrev[0] / lenPrev, toPrev[1] / lenPrev];
    const uNext: Point = [toNext[0] / lenNext, toNext[1] / lenNext];
    const angle = Math.acos(Math.max(-1, Math.min(1, uPrev[0] * uNext[0] + uPrev[1] * uNext[1])));
    if (angle < 1e-3 || Math.PI - angle < 1e-3) {
      out.push(v);
      continue;
    }
    // Share an edge with a rounded neighbour; take all of it from a sharp one.
    const maxPrev = lenPrev * (radii[prevIndex]! > 0 ? 0.5 : 1);
    const maxNext = lenNext * (radii[nextIndex]! > 0 ? 0.5 : 1);
    const cut = Math.min(r / Math.tan(angle / 2), maxPrev, maxNext);
    const arcRadius = cut * Math.tan(angle / 2);
    const start: Point = [v[0] + uPrev[0] * cut, v[1] + uPrev[1] * cut];
    const end: Point = [v[0] + uNext[0] * cut, v[1] + uNext[1] * cut];
    // The centre sits on the bisector, arcRadius from both edges.
    const bisector: Point = [uPrev[0] + uNext[0], uPrev[1] + uNext[1]];
    const bisectorLen = Math.hypot(...bisector);
    const centreDistance = arcRadius / Math.sin(angle / 2);
    const centre: Point = [
      v[0] + (bisector[0] / bisectorLen) * centreDistance,
      v[1] + (bisector[1] / bisectorLen) * centreDistance,
    ];
    let from = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
    let to = Math.atan2(end[1] - centre[1], end[0] - centre[0]);
    // Always take the short way round the corner.
    if (to - from > Math.PI) to -= TAU;
    if (from - to > Math.PI) to += TAU;
    out.push(...arc(centre[0], centre[1], arcRadius, from, to));
  }
  return out;
}

/** Vertices of a regular polygon, the first at `startDeg` (−90 is the top). */
function regular(count: number, startDeg = -90): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const t = startDeg * DEG + (TAU * i) / count;
    return [Math.cos(t), Math.sin(t)] as Point;
  });
}

/** Alternating outer and inner vertices of a star, a tip at the top. */
function star(points: number, inner: number, startDeg = -90): Point[] {
  return Array.from({ length: points * 2 }, (_, i) => {
    const t = startDeg * DEG + (Math.PI * i) / points;
    const r = i % 2 === 0 ? 1 : inner;
    return [r * Math.cos(t), r * Math.sin(t)] as Point;
  });
}

/** A closed curve r(θ), θ = 0 at the top, going clockwise. */
function polar(r: (theta: number) => number, steps = 360): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const theta = (TAU * i) / steps;
    const radius = r(theta);
    return [radius * Math.sin(theta), -radius * Math.cos(theta)] as Point;
  });
}

/** Rounded lobes with pinched valleys, like overlapping circles. */
const lobes =
  (count: number, depth: number, fullness = 0.6) =>
  (theta: number) =>
    1 - depth + depth * Math.abs(Math.cos((count / 2) * theta)) ** fullness;

function rotate(points: Point[], deg: number): Point[] {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return points.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

function scale(points: Point[], sx: number, sy = sx): Point[] {
  return points.map(([x, y]) => [x * sx, y * sy]);
}

/** A stair-stepped outline from row half-widths, left edge mirrored or flat. */
function pixelRows(halfWidths: number[], mirrored: boolean): Point[] {
  const rows = halfWidths.length;
  const right: Point[] = [];
  const left: Point[] = [];
  halfWidths.forEach((w, i) => {
    right.push([w, i], [w, i + 1]);
    left.unshift([mirrored ? -w : 0, i + 1], [mirrored ? -w : 0, i]);
  });
  return mirrored ? [...right, ...left] : [...right, [0, rows], [0, 0]];
}

const SHAPE_POINTS: Record<ProjectShapeId, () => Point[]> = {
  circle: () => polar(() => 1, 120),
  square: () => rounded(regular(4, -45), 0.42),
  slanted: () =>
    rounded(
      [
        [-0.82, -1],
        [1, -1],
        [0.82, 1],
        [-1, 1],
      ],
      0.32,
    ),
  arch: () => {
    const top = arc(0, 0, 1, Math.PI, TAU);
    return rounded([...top, [1, 1], [-1, 1]], [...Array<number>(top.length).fill(0), 0.3, 0.3]);
  },
  semicircle: () => {
    const top = arc(0, 0, 1, Math.PI, TAU);
    return rounded(
      [...top, [1, 0.24], [-1, 0.24]],
      [...Array<number>(top.length).fill(0), 0.14, 0.14],
    );
  },
  oval: () =>
    rotate(
      scale(
        polar(() => 1, 120),
        1,
        0.66,
      ),
      -40,
    ),
  pill: () =>
    rotate(
      rounded(
        [
          [-1.15, -0.85],
          [1.15, -0.85],
          [1.15, 0.85],
          [-1.15, 0.85],
        ],
        0.85,
      ),
      -45,
    ),
  triangle: () => rounded(regular(3), 0.24),
  arrow: () =>
    rounded(
      [
        [0, -1],
        [0.95, 0.72],
        [0, 0.48],
        [-0.95, 0.72],
      ],
      [0.24, 0.26, 0.9, 0.26],
    ),
  fan: () => {
    const curve = arc(-1, 1, 2, -88 * DEG, 0);
    return rounded(
      [[-1, -1], ...curve.slice(1, -1), [1, 1], [-1, 1]],
      [0.16, ...Array<number>(curve.length - 2).fill(0), 0.18, 0.18],
    );
  },
  diamond: () =>
    rounded(
      [
        [0, -1],
        [0.8, 0],
        [0, 1],
        [-0.8, 0],
      ],
      0.2,
    ),
  clamshell: () =>
    rounded(
      [
        [-0.55, -0.68],
        [0.55, -0.68],
        [1, 0],
        [0.55, 0.68],
        [-0.55, 0.68],
        [-1, 0],
      ],
      0.2,
    ),
  pentagon: () => rounded(regular(5), 0.24),
  gem: () =>
    rounded(
      [
        [0, -1],
        [0.9, -0.38],
        [0.96, 0.56],
        [0, 1],
        [-0.96, 0.56],
        [-0.9, -0.38],
      ],
      [0.22, 0.26, 0.26, 0.22, 0.26, 0.26],
    ),
  "very-sunny": () => rounded(star(8, 0.74), 0.16),
  sunny: () => rounded(star(8, 0.82), [0.1, 0.3]),
  "cookie-4": () => polar((t) => 1 + 0.12 * Math.cos(4 * t + Math.PI)),
  "cookie-6": () => polar((t) => 1 + 0.075 * Math.cos(6 * t)),
  "cookie-7": () => polar((t) => 1 + 0.07 * Math.cos(7 * t)),
  "cookie-9": () => polar((t) => 1 + 0.06 * Math.cos(9 * t)),
  "cookie-12": () => polar((t) => 1 + 0.055 * Math.cos(12 * t)),
  "clover-4": () => rotate(polar(lobes(4, 0.42, 0.55)), 45),
  "clover-8": () => polar(lobes(8, 0.24, 0.5)),
  burst: () => rounded(star(12, 0.7), [0.02, 0.01]),
  "soft-burst": () => rounded(star(10, 0.76), [0.1, 0.08]),
  boom: () => rounded(star(16, 0.36), [0.01, 0.02]),
  "soft-boom": () => polar(lobes(16, 0.55, 0.3), 720),
  flower: () => polar((t) => 0.62 + 0.38 * ((1 + Math.cos(8 * t)) / 2) ** 0.75),
  puffy: () => scale(polar(lobes(12, 0.16, 0.5)), 1, 0.78),
  "puffy-diamond": () =>
    polar((t) => {
      const big = (1 + Math.cos(4 * t)) / 2;
      return 0.62 + 0.38 * Math.abs(Math.cos(4 * t)) ** 0.55 * (0.55 + 0.45 * big);
    }),
  ghost: () => {
    const top = arc(0, 0, 1, Math.PI, TAU);
    return rounded(
      [...top, [1, 0.98], [0, 0.66], [-1, 0.98]],
      [...Array<number>(top.length).fill(0), 0.32, 0.9, 0.32],
    );
  },
  "pixel-circle": () => {
    const rows = 12;
    const widths = Array.from({ length: rows }, (_, i) => {
      const y = (i + 0.5 - rows / 2) / (rows / 2);
      return Math.round(Math.sqrt(1 - y * y) * (rows / 2) + 0.25);
    });
    return pixelRows(widths, true);
  },
  "pixel-triangle": () => {
    const rows = 12;
    const widths = Array.from({ length: rows }, (_, i) => Math.min(i, rows - 1 - i) + 1);
    return scale(pixelRows(widths, false), 1.5, 1);
  },
  bun: () => {
    // Two stacked stadiums that overlap, pinched where they meet.
    const r = 0.5;
    const cy = 0.42;
    const pinch = Math.atan2(cy, Math.sqrt(r * r - cy * cy));
    return [
      ...arc(0.5, -cy, r, -Math.PI / 2, pinch),
      ...arc(0.5, cy, r, -pinch, Math.PI / 2),
      ...arc(-0.5, cy, r, Math.PI / 2, Math.PI + pinch),
      ...arc(-0.5, -cy, r, Math.PI - pinch, (3 * Math.PI) / 2),
    ];
  },
  heart: () =>
    Array.from({ length: 240 }, (_, i) => {
      const t = (TAU * i) / 240;
      return [
        16 * Math.sin(t) ** 3,
        -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
      ] as Point;
    }),
};

/** Scale and centre points into the shared 100 box, keeping proportions. */
function fit(points: Point[]): Point[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const s = FIT / Math.max(maxX - minX, maxY - minY);
  const ox = 50 - ((minX + maxX) / 2) * s;
  const oy = 50 - ((minY + maxY) / 2) * s;
  return points.map(([x, y]) => [x * s + ox, y * s + oy]);
}

const pathCache = new Map<ProjectShapeId, string>();

/** The shape's outline as SVG path data in a `0 0 100 100` viewBox. */
export function projectShapePath(shape: ProjectShapeId): string {
  const cached = pathCache.get(shape);
  if (cached) return cached;
  const points = fit(SHAPE_POINTS[shape]());
  const path = `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`;
  pathCache.set(shape, path);
  return path;
}

const SHAPE_LABELS: Record<ProjectShapeId, string> = {
  circle: "Circle",
  square: "Square",
  slanted: "Slanted",
  arch: "Arch",
  semicircle: "Semicircle",
  oval: "Oval",
  pill: "Pill",
  triangle: "Triangle",
  arrow: "Arrow",
  fan: "Fan",
  diamond: "Diamond",
  clamshell: "Clamshell",
  pentagon: "Pentagon",
  gem: "Gem",
  "very-sunny": "Very sunny",
  sunny: "Sunny",
  "cookie-4": "4-sided cookie",
  "cookie-6": "6-sided cookie",
  "cookie-7": "7-sided cookie",
  "cookie-9": "9-sided cookie",
  "cookie-12": "12-sided cookie",
  "clover-4": "4-leaf clover",
  "clover-8": "8-leaf clover",
  burst: "Burst",
  "soft-burst": "Soft burst",
  boom: "Boom",
  "soft-boom": "Soft boom",
  flower: "Flower",
  puffy: "Puffy",
  "puffy-diamond": "Puffy diamond",
  ghost: "Ghost",
  "pixel-circle": "Pixel circle",
  "pixel-triangle": "Pixel triangle",
  bun: "Bun",
  heart: "Heart",
};

export function projectShapeLabel(shape: ProjectShapeId): string {
  return SHAPE_LABELS[shape];
}
