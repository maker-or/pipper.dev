'use client'

import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { captureStates, StateRow, type StateSnapshot } from './sheet-states'
import { useSheetPlayback } from './sheet-playback'
import { colourOf, posterColours, PosterStyleContext, type Swatch, SYSTEM } from './poster-style'
import styles from './spec.module.css'

// The parts every spec sheet shares: the page (title, figure 1, moments, notes, specification, figure 2, foot), the
// driver that holds a component's real CSS transitions at a moment and glides between moments, and the drawing
// vocabulary (dimensions, callouts, the curve, the timeline). A sheet supplies only its component and what to draw.

export const r1 = (n: number) => Number(n.toFixed(1))

// The system colours (SYSTEM in poster-style: macOS and iOS 26, light and dark). Each spec takes its own: the swatch
// on lines, fills and marks, a tint of it under the run, and a darker ink of the same hue for words, so even yellow
// and mint read on white; in dark, the dark value of the same swatch.
export { SYSTEM, type Swatch }
export const IOS26 = SYSTEM.light
// Which spec has which swatch. A new spec takes one nobody has; once all twelve are in use, the least-used one.
// Breaking that (a repeat while a swatch is unused, or one swatch two uses ahead of another) is an error.
export const SPEC_ACCENTS: Record<string, Swatch> = {
  // one line per poster in this project (the example's below: drop it with the example)
  copy: 'purple',
}
if (process.env.NODE_ENV !== 'production') {
  const count = (s: Swatch) => Object.values(SPEC_ACCENTS).filter((v) => v === s).length
  const counts = (Object.keys(SYSTEM.light) as Swatch[]).map(count)
  if (Math.max(...counts) - Math.min(...counts) > 1) throw new Error('Accents must stay even: give a new spec the least-used swatch')
}
// (the ink is darkened on light paper and lifted on dark, so accent words keep their contrast either way; a paper
// or an accent picked in the strip's toolbar takes over, with every colour worked out from the two in poster-style)
const accentVars = (spec: string, dark: boolean, paper?: string, accent?: string) => {
  if (!SPEC_ACCENTS[spec]) throw new Error(`Give "${spec}" a swatch in SPEC_ACCENTS: the least-used one`)
  const c = SYSTEM[dark ? 'dark' : 'light'][SPEC_ACCENTS[spec]]
  const p = colourOf(paper, dark), a = colourOf(accent, dark)
  if (p || a) return posterColours(p ?? (dark ? '#000000' : '#ffffff'), a ?? c).vars
  return {
    '--accent': c,
    '--accent-tint': `color-mix(in oklch, ${c} ${dark ? 22 : 12}%, var(--paper))`,
    '--accent-ink': dark ? `oklch(from ${c} max(l, 0.74) c h)` : `oklch(from ${c} min(l, 0.52) c h)`,
  } as React.CSSProperties
}

// The poster is set in Inter. An app that already loads it under that name is left alone; otherwise it's fetched
// once from Google Fonts, so a fresh project doesn't fall back to the system's face.
const INTER = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap'
function useInter() {
  useEffect(() => {
    if (document.fonts.check('12px Inter') && [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Inter')) return
    if (document.querySelector(`link[href="${INTER}"]`)) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'; link.href = INTER
    document.head.append(link)
  }, [])
}

// The poster follows the app's own theme, passed in: dark only when the app itself is dark. Once the new colours
// have painted, the moments are captured again in them (they're copies, not live).
function useThemeRefresh(dark: boolean) {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('spec-theme'))))
    return () => cancelAnimationFrame(id)
  }, [dark])
}

// (CSS's keyword easings, as the curves they stand for)
const KEYWORDS: Record<string, string> = { ease: 'cubic-bezier(0.25, 0.1, 0.25, 1)', 'ease-in': 'cubic-bezier(0.42, 0, 1, 1)', 'ease-out': 'cubic-bezier(0, 0, 0.58, 1)', 'ease-in-out': 'cubic-bezier(0.42, 0, 0.58, 1)' }
export function easeAt(time: number, easing: string) {
  easing = KEYWORDS[easing.trim()] ?? easing
  if (easing.trim().startsWith('linear(')) return linearAt(time, easing)
  const values = easing.match(/cubic-bezier\(([^)]+)\)/)?.[1].split(',').map(Number)
  if (!values || values.length !== 4) return time
  const [x1, y1, x2, y2] = values
  const coordinate = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3
  let low = 0, high = 1
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2
    if (coordinate(middle, x1, x2) < time) low = middle
    else high = middle
  }
  return coordinate((low + high) / 2, y1, y2)
}
// CSS linear(): points joined by straight lines, which is how springs reach CSS and the Web Animations API (Motion
// hands a spring to the browser this way). Each point is a value with up to two positions; a missing position is
// spread evenly between its neighbours, the first defaulting to 0% and the last to 100%.
export function linearStops(easing: string) {
  const body = easing.match(/linear\((.*)\)/)?.[1] ?? ''
  const pts: { v: number; at: number | null }[] = []
  for (const part of body.split(',')) {
    const [v, ...at] = part.trim().split(/\s+/)
    if (!at.length) pts.push({ v: Number(v), at: null })
    for (const a of at) pts.push({ v: Number(v), at: parseFloat(a) / 100 })
  }
  if (!pts.length) return []
  if (pts[0].at === null) pts[0].at = 0
  if (pts[pts.length - 1].at === null) pts[pts.length - 1].at = 1
  for (let i = 1; i < pts.length; i++) {
    // (a position never goes back; a run of missing ones shares the gap evenly)
    if (pts[i].at !== null) { pts[i].at = Math.max(pts[i].at!, pts[i - 1].at!); continue }
    let j = i; while (pts[j].at === null) j++
    for (let n = i; n < j; n++) pts[n].at = pts[i - 1].at! + ((pts[j].at! - pts[i - 1].at!) * (n - i + 1)) / (j - i + 1)
    i = j - 1
  }
  return pts as { v: number; at: number }[]
}
function linearAt(time: number, easing: string) {
  const pts = linearStops(easing)
  if (!pts.length) return time
  if (time <= pts[0].at) return pts[0].v
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    if (time <= b.at) return b.at === a.at ? b.v : a.v + ((b.v - a.v) * (time - a.at)) / (b.at - a.at)
  }
  return pts[pts.length - 1].v
}

// A spring's progress (0 at the start, 1 at rest) `ms` after release, from its physics: stiffness, damping and mass,
// and its starting velocity in progress a second. Use it only when the spring's own function can't be read from the
// running animation (see references/drivers.md), and say on the poster that the curve is derived from the config.
export type Spring = { stiffness: number; damping: number; mass?: number; velocity?: number }
export function springAt(ms: number, { stiffness: k, damping: c, mass = 1, velocity: v0 = 0 }: Spring) {
  const t = ms / 1000, w0 = Math.sqrt(k / mass), z = c / (2 * Math.sqrt(k * mass))
  let d: number
  if (z < 1) { const wd = w0 * Math.sqrt(1 - z * z); d = Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0 - v0) / wd) * Math.sin(wd * t)) }
  else if (z === 1) d = Math.exp(-w0 * t) * (1 + (w0 - v0) * t)
  else { const q = w0 * Math.sqrt(z * z - 1), r1 = -z * w0 + q, r2 = -z * w0 - q, a = (-v0 - r2) / (r1 - r2); d = a * Math.exp(r1 * t) + (1 - a) * Math.exp(r2 * t) }
  return 1 - d
}
// When a curve (progress over ms) comes to rest: the last moment it's further than `delta` from 1, scanning back
// from `max`. A spring has no duration of its own; this is the one the poster states, with the delta it used.
export function settleTime(f: (ms: number) => number, max = 10000, delta = 0.005) {
  for (let ms = max; ms >= 0; ms -= 1) if (Math.abs(1 - f(ms)) > delta) return ms + 1
  return 0
}
// The furthest a curve goes past 1 (0 when it never does): a spring's overshoot, as a fraction of the move
export function overshoot(f: (ms: number) => number, max: number) {
  let top = 1
  for (let i = 0; i <= 400; i++) top = Math.max(top, f((max * i) / 400))
  return top - 1
}

// The first timing function in a computed list ("cubic-bezier(0.22, 1, 0.36, 1), ease"). Splitting on commas cuts a
// cubic-bezier() in half and every curve drawn from it comes out wrong.
export const firstEasing = (v: string) => v.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|linear\([^)]*\)|[a-z-]+/)?.[0] ?? 'ease'

// An easing in words, named by its shape, not assumed: a curve that starts slower than a straight line eases in, one
// that ends slower eases out, one that does both eases in and out. A linear() (a spring handed to CSS) and steps()
// are named for what they are.
export const easeWords = (easing: string) => {
  const e = easing.trim()
  if (e === 'linear') return 'Linear'
  if (e.startsWith('linear(')) return `Linear stops (${linearStops(e).length} points, a spring or a custom curve)`
  if (e.startsWith('steps(')) return `Steps (${e.match(/\(([^)]+)\)/)?.[1]})`
  const curve = KEYWORDS[e] ?? e
  const v = curve.match(/cubic-bezier\(([^)]+)\)/)?.[1].split(',').map(Number)
  if (!v || v.length !== 4) return easing
  const [x1, y1, x2, y2] = v
  // (the curve's slope where it leaves 0 and where it reaches 1: under 1 is slower than linear)
  const slowStart = x1 > 0 && y1 / x1 < 1, slowEnd = x2 < 1 && (1 - y2) / (1 - x2) < 1
  const shape = slowStart && slowEnd ? 'Ease-in-out' : slowEnd ? 'Ease-out' : slowStart ? 'Ease-in' : 'Linear-ish'
  return `${KEYWORDS[e] ? `${e[0].toUpperCase()}${e.slice(1)}` : shape} (${v.join(', ')})`
}

// A keyframed animation's own stops (offset, value, the easing into the next), read off the running animation, and
// its value at any fraction of its run: for overshoots, which no single easing curve describes.
export type Stop = { at: number; v: number; easing: string }
export function stopsOf(a: Animation, value: (k: ComputedKeyframe) => number): Stop[] {
  return (a.effect as KeyframeEffect).getKeyframes().map((k) => ({ at: Number(k.computedOffset), v: value(k), easing: String(k.easing ?? 'linear') }))
}
export function sampleStops(stops: Stop[], f: number) {
  const t = Math.max(0, Math.min(1, f))
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1]
    if (t <= b.at) return a.v + (b.v - a.v) * easeAt(b.at === a.at ? 1 : (t - a.at) / (b.at - a.at), a.easing)
  }
  return stops[stops.length - 1].v
}
export const scaleOf = (k: ComputedKeyframe) => parseFloat(String(k.transform).match(/scale\(([^)]+)\)/)?.[1] ?? '1')

// a number with its unit set lighter, so the eye lands on the value (HTML and SVG)
export const U = ({ v, u }: { v: ReactNode; u: string }) => <>{v}<span className={styles.unit}>{u}</span></>
export const Ut = ({ v, u }: { v: ReactNode; u: string }) => <>{v}<tspan className={styles.unit}>{u}</tspan></>

// the drawing's scale on the poster: fixed, since the whole poster scales with the window instead
export function useDrawingScale(base = 2) {
  return base
}

// The drawing scale that puts a component at screen scale 1, whatever the poster's own scale: for a component that
// measures itself on screen (getBoundingClientRect) and compares that with its own px, as a drag threshold or a
// swipe distance does. Scaled by the poster, the two disagree and its decisions move; at screen scale 1 they don't.
// Pass any element inside the poster.
export function useScreenScale(inside: React.RefObject<HTMLElement | null>) {
  const [z, setZ] = useState(1)
  useLayoutEffect(() => {
    const read = () => { const p = inside.current?.closest<HTMLElement>('[data-poster]'); if (p) setZ(p.offsetWidth / p.getBoundingClientRect().width) }
    read()
    const ro = new ResizeObserver(read); ro.observe(document.body)
    window.addEventListener('resize', read)
    return () => { ro.disconnect(); window.removeEventListener('resize', read) }
  }, [inside])
  return z
}

// Moments captured one at a time (by a custom driver, each after its own run) put in one camera, as captureEach
// does for a row it takes in one go: each copy re-placed in the union of their frames, so growth reads as growth.
export function oneCamera(shots: StateSnapshot[]): StateSnapshot[] {
  const L = Math.min(...shots.map((s) => s.left)), T = Math.min(...shots.map((s) => s.top))
  const W = Math.max(...shots.map((s) => s.left + s.width)) - L, H = Math.max(...shots.map((s) => s.top + s.height)) - T
  return shots.map((s) => ({ ...s, left: L, top: T, width: W, height: H, html: `<div style="position:absolute;left:${s.left - L}px;top:${s.top - T}px">${s.html}</div>` }))
}

// The poster's scale: A4 portrait (794 × 1123), as large as the space allows: the stage's width, and the window's
// height below wherever the stage starts (under the app's own header or nav, whatever its height). In the strip
// (spec-strip.tsx) a poster isn't held to a width, only to the window's, less a peek of the next one.
export const A4 = { w: 794, h: 1123 }
// (turned on its side when the toolbar asks for landscape)
const sheetSize = (layout: 'portrait' | 'landscape') => (layout === 'landscape' ? { w: A4.h, h: A4.w } : A4)
export const InStrip = createContext(false)
function usePosterScale(stage: React.RefObject<HTMLElement | null>, strip: boolean, size: { w: number; h: number }) {
  const [k, setK] = useState(0.6)
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const fit = () => {
      // (in the strip, the row's own height less its padding, the toolbar's room: the poster is centred in it, so
      // its own top follows its scale)
      const row = strip ? el.closest<HTMLElement>('[data-spec-strip]') : null
      const pad = row ? parseFloat(getComputedStyle(row).paddingTop) + parseFloat(getComputedStyle(row).paddingBottom) : 0
      const tall = row ? row.clientHeight - pad - 42 : window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 42
      const wide = strip ? window.innerWidth - 42 - 55 : el.clientWidth - 42
      setK(Math.max(0.1, Math.min(wide / size.w, tall / size.h)))
    }
    fit()
    // (the stage's width, and anything above it changing height, both refit it)
    const ro = new ResizeObserver(fit)
    ro.observe(el); ro.observe(document.body)
    window.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit); ro.disconnect() }
  }, [stage, strip, size.w, size.h])
  return k
}

// Crisp hairlines: a 1px line drawn on a device pixel's centre, not across two. The drawing may be scaled (the
// poster is), so its own units are taken to screen pixels and back.
export type Snap = (v: number, axis: 'x' | 'y') => number
export function useCrisp() {
  const ref = useRef<SVGSVGElement>(null)
  const [o, setO] = useState({ x: 0, y: 0, d: 1, k: 1 })
  useLayoutEffect(() => {
    const svg = ref.current
    const r = svg?.getBoundingClientRect()
    if (!svg || !r) return
    const d = window.devicePixelRatio || 1
    // (the poster's scale: drawings are drawn 1:1 inside it)
    const poster = svg.closest<HTMLElement>('[data-poster]')
    const k = poster ? poster.getBoundingClientRect().width / poster.offsetWidth : 1
    setO((p) => (p.x === r.left && p.y === r.top && p.d === d && p.k === k ? p : { x: r.left, y: r.top, d, k }))
  })
  const snap: Snap = (v, axis) => {
    const at = axis === 'x' ? o.x : o.y
    const device = Math.round((at + v * o.k) * o.d - 0.5) + 0.5
    return (device / o.d - at) / o.k
  }
  return { ref, snap }
}

// A horizontal dimension: extension lines off both measured points, a line between with a slash at each end, the
// size above or below it.
export function Dim({ x1: a, x2: b, y: c, from, label, below = false, snap, part = 'n2' }: { x1: number; x2: number; y: number; from: number; label: ReactNode; below?: boolean; snap: Snap; part?: string }) {
  const x1 = snap(a, 'x'), x2 = snap(b, 'x'), y = snap(c, 'y')
  const s = (x: number) => `M${x - 3} ${y + 3}L${x + 3} ${y - 3}`
  const gap = below ? 3 : -3
  return <g className={styles.dim} data-part={part}>
    <path d={`M${x1} ${from + gap}V${y + (below ? 5 : -5)}M${x2} ${from + gap}V${y + (below ? 5 : -5)}`} className={styles.extension} />
    <line x1={x1} x2={x2} y1={y} y2={y} />
    <path d={s(x1) + s(x2)} />
    <text x={(x1 + x2) / 2} y={below ? y + 16 : y - 8} textAnchor="middle">{label}</text>
  </g>
}

// A vertical dimension, the same parts turned upright, the size beside it (left of the line when `left`).
export function VDim({ y1: a, y2: b, x: c, from, label, left = false, snap, part = 'n2' }: { y1: number; y2: number; x: number; from: number; label: ReactNode; left?: boolean; snap: Snap; part?: string }) {
  const y1 = snap(a, 'y'), y2 = snap(b, 'y'), x = snap(c, 'x')
  const s = (y: number) => `M${x - 3} ${y + 3}L${x + 3} ${y - 3}`
  const gap = left ? -3 : 3
  return <g className={styles.dim} data-part={part}>
    <path d={`M${from + gap} ${y1}H${x + (left ? -5 : 5)}M${from + gap} ${y2}H${x + (left ? -5 : 5)}`} className={styles.extension} />
    <line x1={x} x2={x} y1={y1} y2={y2} />
    <path d={s(y1) + s(y2)} />
    <text x={left ? x - 8 : x + 8} y={(y1 + y2) / 2 + 4} textAnchor={left ? 'end' : 'start'}>{label}</text>
  </g>
}

// a superellipse (n = 4) of radius r round x, y: the same squircle as the notes' numbers
export function squircle(x: number, y: number, r: number) {
  return Array.from({ length: 48 }, (_, i) => {
    const t = (i / 48) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t)
    return `${i ? 'L' : 'M'}${x + r * Math.sign(c) * Math.abs(c) ** 0.5} ${y + r * Math.sign(s) * Math.abs(s) ** 0.5}`
  }).join('') + 'Z'
}

// A numbered callout. Every leader leaves its part at 45°, `len` along each axis, in the direction given, so the
// leaders on a sheet read as one set; or straight across ('e', 'w') where a gap between parts is the only clear way.
export type Dir = 'ne' | 'se' | 'sw' | 'nw' | 'e' | 'w'
export function Callout({ n, x, y, dir, len = 34 }: { n: number; x: number; y: number; dir: Dir; len?: number }) {
  const tx = x + (dir.includes('e') ? len : -len), ty = y + (dir.length === 1 ? 0 : dir.includes('s') ? len : -len)
  return <g className={styles.callout} data-part={`n${n}`}>
    <line x1={x} y1={y} x2={tx} y2={ty} data-bts-leader />
    <circle cx={x} cy={y} r={2.25} className={styles.point} />
    <path d={squircle(tx, ty, 10.5)} className={styles.badge} />
    <text x={tx} y={ty + 3.5} textAnchor="middle">{n}</text>
  </g>
}

// The overlay that sits on figure 1: same origin and scale as the component under it.
export function Overlay({ w, h, children, svgRef }: { w: number; h: number; children: ReactNode; svgRef?: React.Ref<SVGSVGElement> }) {
  return <svg ref={svgRef} className={styles.overlay} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" data-bts-overlay>{children}</svg>
}
export const markClass = { ghost: styles.ghost, reference: styles.reference, mark: styles.mark2, underline: styles.mark1, hatch: styles.hatch }

// Figure 2: one or more curves over x (time, or scroll), the first one carrying the current point and its value.
export type Series = { f: (x: number) => number; className?: string }
export function Curve({ x, max, series, end, unit = '', label, marks = [] }: { x: number; max: number; series: Series[]; end: ReactNode; unit?: string; label?: ReactNode; marks?: number[] }) {
  // (drawn at its column's own width, 1:1, so it fills the column and its words stay 12px)
  const svg = useRef<SVGSVGElement>(null)
  const [cw, setCw] = useState(229)
  useLayoutEffect(() => {
    const w = svg.current?.parentElement?.clientWidth
    if (w && Math.abs(w - cw) > 0.5) setCw(w)
  })
  const L = 21, T = 8, W = cw - L - 8, H = 117
  // (the range reaches past 0 and 1 when a curve does, a spring's overshoot say, so nothing is cut off at the edge)
  let lo = 0, hi = 1
  for (const s of series) for (let i = 0; i <= 80; i++) { const v = s.f((max * i) / 80); lo = Math.min(lo, v); hi = Math.max(hi, v) }
  const X = (v: number) => L + (W * v) / max, Y = (k: number) => T + (H * (hi - k)) / (hi - lo)
  const path = (f: (v: number) => number) => Array.from({ length: 81 }, (_, i) => `${i ? 'L' : 'M'}${X((max * i) / 80)} ${Y(f((max * i) / 80))}`).join('')
  const k = series[0].f(x)
  // (high on a lone curve, the value goes above and left of the point; with a second series up there, it stays below,
  // unless the point is past 1, where below would sit on the rest line)
  const high = (k > 0.8 && series.length === 1) || k > 1
  const cx = X(x), cy = Y(k)
  return (
    <svg ref={svg} className={styles.curve} viewBox={`0 0 ${L + W + 8} ${T + H + 21}`} role="img" aria-label={`${r1(x)} of ${max}${unit}, ${Math.round(k * 100)} percent.`}>
      <path d={`M${L} ${T}V${T + H}M${L} ${Y(0)}H${L + W}`} className={styles.axis} />
      <line x1={L} y1={Y(0)} x2={L + W} y2={Y(1)} className={styles.referenceLine} />
      {/* (where it comes to rest, when the curve goes past it) */}
      {hi > 1 && <line x1={L} y1={Y(1)} x2={L + W} y2={Y(1)} className={styles.guide} />}
      {series.slice(1).map((s, i) => <path key={i} d={path(s.f)} className={s.className ?? styles.ease} />)}
      <path d={path(series[0].f)} className={series[0].className ?? styles.ease} />
      {marks.map((v) => <circle key={v} cx={X(v)} cy={Y(series[0].f(v))} r={2.5} className={styles.mark} />)}
      <path d={`M${L} ${cy}H${cx}V${Y(0)}`} className={styles.guide} />
      <circle cx={cx} cy={cy} r={3.5} className={styles.dot} />
      <text x={L - 8} y={Y(1) + 4} textAnchor="end">1</text>
      <text x={L - 8} y={Y(0) + 4} textAnchor="end">0</text>
      {/* (on the side of the point away from the reference diagonal: above and to the left when the point is above it,
          as an ease-out's is, where the curve behind it runs lower; below and to the right when it's under it. Above
          and to the left too when the point is high or near the curve's end, where the right would be off the sheet,
          unless that's the axis's own labels: then to its right) */}
      {(() => { const end = cx > L + W - 55, ahead = k > x / max + 0.02, above = high || end || ahead, left = (above && cx > L + 55) || end; return <text x={left ? cx - 8 : cx + 8} y={above ? cy - 8 : cy + 15} textAnchor={left ? 'end' : 'start'} className={styles.accentText}>{label ?? <Ut v={Math.round(k * 100)} u="%" />}</text> })()}
      {/* (the time under the point, kept inside the axis at either end) */}
      <text x={cx} y={T + H + 17} textAnchor={cx > L + W - 21 ? 'end' : cx < L + 21 ? 'start' : 'middle'} className={styles.accentText}>{r1(x)}</text>
      {Math.abs(cx - (L + W)) > 55 && <text x={L + W} y={T + H + 17} textAnchor="end">{end}</text>}
    </svg>
  )
}

// The moments row: the frames, then the run as a band under them, each frame's leader landing on it at its moment.
const COL = 144, GAP = 34, ROW = COL * 3 + GAP * 2
const centre = (i: number) => i * (COL + GAP) + COL / 2
export function Timeline({ value, max, f, marks, selected, label }: { value: number; max: number; f: (v: number) => number; marks: number[]; selected: number; label: ReactNode }) {
  const X = (v: number) => 1 + (v / max) * (ROW - 2)
  const base = 55, rise = 34
  const Y = (v: number) => base - rise * f(Math.max(0, Math.min(max, v)))
  const curve = (end: number) => Array.from({ length: 61 }, (_, i) => { const v = (end * i) / 60; return `${i ? 'L' : 'M'}${X(v)} ${Y(v)}` }).join('')
  const { ref, snap } = useCrisp()
  const by = snap(base, 'y')
  const step = max / 10
  return (
    <svg ref={ref} data-part="n2 curve" className={styles.timeline} viewBox={`0 0 ${ROW} 76`} role="img" aria-label={`At ${r1(value)} of ${max}.`}>
      <path d={`${curve(max)}V${base}H${X(0)}Z`} className={styles.band} />
      <path d={`${curve(value)}V${base}H${X(0)}Z`} className={styles.bandOn} />
      <path d={curve(max)} className={styles.track} fill="none" />
      <path d={curve(value)} className={styles.progress} fill="none" />
      {marks.map((v, i) => <path key={i} d={`M${centre(i)} 0V8L${X(v)} ${Y(v) - 5}`} className={i === selected ? styles.leaderOn : styles.leader} />)}
      <line x1={0} x2={ROW} y1={by} y2={by} className={styles.track} />
      {Array.from({ length: 11 }, (_, k) => <line key={k} x1={snap(X(k * step), 'x')} x2={snap(X(k * step), 'x')} y1={by} y2={by + (k % 2 ? 3 : 5)} className={styles.track} />)}
      {marks.map((v, i) => <circle key={i} cx={X(v)} cy={Y(v)} r={3} className={i === selected ? styles.markOn : styles.mark} />)}
      <line x1={X(value)} x2={X(value)} y1={Y(value)} y2={base} className={styles.playhead} />
      <circle cx={X(value)} cy={base} r={2.5} className={styles.dot} />
      <text x={X(value)} y={base + 18} textAnchor={value > max * 0.9 ? 'end' : value < max * 0.06 ? 'start' : 'middle'} className={styles.accentText}>{label}</text>
    </svg>
  )
}

// (crop: the part of the component that changes, in its own px; each frame shows only that, its cut edges faded)
export type Crop = { x: number; y: number; w: number; h: number }
const cropTo = (s: StateSnapshot, c: Crop, fade: string): StateSnapshot => ({
  ...s, width: c.w, height: c.h,
  html: `<div style="position:relative;width:${c.w}px;height:${c.h}px;overflow:hidden;mask-image:${fade}"><div style="position:absolute;left:${s.left - c.x}px;top:${s.top - c.y}px">${s.html}</div></div>`,
})
export function Moments({ snapshots, labels, selected, onSelect, timeline, height = 55, crop }: { snapshots: StateSnapshot[]; labels: readonly string[]; selected: number; onSelect: (i: number) => void; timeline: ReactNode; height?: number; crop?: Crop }) {
  const fade = 'linear-gradient(transparent, #000 13px, #000 calc(100% - 13px), transparent)'
  const shown = crop ? snapshots.map((s) => cropTo(s, crop, fade)) : snapshots
  return <div className={styles.moments} style={{ ['--thumb-h' as string]: `${height}px` }}>
    <StateRow compact bare images={shown} labels={labels} selected={selected} onSelect={onSelect} />
    {timeline}
  </div>
}

// The driver for a component animated by CSS transitions. `setup` puts the component at its start with no
// transition and returns what to measure, the change to make (the component's own handler), and how to read it
// while it runs. The real transitions are then paused at each moment, captured for the row, and held at the
// telling one; picking a moment glides the real animations there.
export type Held<B, R> = B & R & { elapsed: number; duration: number; easing: string; reduced: boolean }
// (pick: which of the running animations are the interaction, when others, a button's hover say, run beside it)
export type Setup<B, R> = { base: B | (() => B); easing: string; trigger: () => void | Promise<void>; read: () => R; pick?: (all: Animation[]) => Animation[] }

// a box's left, top and size inside a root, in the root's own px, whatever the drawing's and the poster's scale
export const within = (root: HTMLElement, el: Element) => {
  const r = root.getBoundingClientRect(), b = el.getBoundingClientRect(), k = r.width / root.offsetWidth
  // (to 0.1px: measuring through a zoom leaves float dust, 219.99997 for 220)
  const t = (v: number) => Math.round(v * 10) / 10
  return { x: t((b.left - r.left) / k), y: t((b.top - r.top) / k), w: t(b.width / k), h: t(b.height / k) }
}
export function useTransitionSpec<B extends object, R extends object>({ fractions, setup }: {
  fractions: readonly number[]
  // (setup may wait, and base may be read after the trigger, for a component whose parts only exist once it's shown.
  // `stale()` turns true once this run has been replaced or the poster has gone, React's development double-run
  // included: a setup that waits before it acts checks it first, or it toggles the component twice)
  setup: (root: HTMLElement, run: { stale: () => boolean }) => Setup<B, R> | Promise<Setup<B, R>>
}) {
  const root = useRef<HTMLDivElement>(null)
  const [m, setM] = useState<Held<B, R> | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState(1)
  const [snapshots, setSnapshots] = useState<StateSnapshot[]>([])
  const playback = useSheetPlayback(ready, m?.reduced, fractions[1])
  const keep = useRef(setup)
  keep.current = setup

  useEffect(() => {
    let alive = true, generation = 0
    const frames = new Set<number>()
    const frame = () => new Promise<void>((resolve) => { const id = requestAnimationFrame(() => { frames.delete(id); resolve() }); frames.add(id) })
    const r = root.current!
    // (tries: a run in which nothing moved is tried once more before the poster shows its error: the component may
    // have been left at its end state, by a hot reload in development, say, and the second run starts it from rest)
    const prepare = async (tries = 2): Promise<void> => {
      const g = ++generation
      setReady(false); setError(false)
      try {
        await document.fonts.ready
        await frame()
        if (!alive || g !== generation) return
        r.getAnimations({ subtree: true }).forEach((a) => a.cancel())
        const s = await keep.current(r, { stale: () => !alive || g !== generation })
        if (!alive || g !== generation) return
        void getComputedStyle(r).opacity
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
        await s.trigger()
        if (!alive || g !== generation) return
        void getComputedStyle(r).opacity
        const base = typeof s.base === 'function' ? (s.base as () => B)() : s.base
        const all = r.getAnimations({ subtree: true })
        // (nothing to pick from under reduced motion, when nothing ran)
        const animations = s.pick && all.length ? s.pick(all) : all
        if (!reduced && !animations.length) throw new Error('No transitions ran')
        // (a looping animation's end is infinite: its one cycle is the run)
        const end = (a: Animation) => { const t = a.effect!.getComputedTiming(); return Number.isFinite(Number(t.endTime)) ? Number(t.endTime) : Number(t.delay ?? 0) + Number(t.duration) }
        const duration = reduced ? 0 : Math.round(Math.max(...animations.map(end)))
        const elapsed = reduced ? 0 : duration * playback.fraction.current
        const captured = reduced ? [] : captureStates(r, animations, duration, fractions)
        animations.forEach((a) => { a.pause(); a.currentTime = elapsed })
        const held = (t: number) => ({ ...base, ...s.read(), elapsed: Math.round(t), duration, easing: s.easing, reduced })
        const first = held(elapsed)
        await frame()
        if (!alive || g !== generation) return
        playback.timeline.current = { root: r, animations, duration, read: (t) => setM(held(t)) }
        setSnapshots(captured); setM(first); setReady(true)
      } catch (e) {
        if (!alive || g !== generation) return
        if (tries > 1) { await frame(); if (alive && g === generation) return prepare(tries - 1); return }
        // (a warning, not an error: the poster says so itself, with its retry, and a development overlay over the
        // whole page would hide it)
        if (process.env.NODE_ENV !== 'production') console.warn('Spec capture failed:', e)
        setError(true)
      }
    }
    void prepare()
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const refresh = () => { void prepare() }
    motion.addEventListener('change', refresh)
    window.addEventListener('spec-theme', refresh)
    return () => {
      alive = false; generation++
      frames.forEach(cancelAnimationFrame)
      r.getAnimations({ subtree: true }).forEach((a) => a.cancel())
      motion.removeEventListener('change', refresh)
      window.removeEventListener('spec-theme', refresh)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  const select = (i: number) => { setSelected(i); playback.glideTo(fractions[i]) }
  return { root, m, ready, error, retry: () => setAttempt((v) => v + 1), snapshots, selected, select, glideTo: playback.glideTo }
}

// (a note per callout: two to four)
export type Note = { part: 'n1' | 'n2' | 'n3' | 'n4'; head: string; body: ReactNode }
export type Row = readonly [string, ReactNode, string]

// (`settled`: for a driver that has to show its poster before it's done, a menu or a drag that needs focus while it
// captures, false until it has finished; the page of all posters waits for it before showing the poster)
// (`lines`: the line types the title block explains, only those the drawing uses)
export function SpecPage({ accent, label, name, ready, settled, error, onRetry, drawing, moments, notes, spec, fig2, units, theme = 'light', lines = ['now', 'start', 'target'] }: {
  theme?: 'light' | 'dark'; lines?: readonly ('now' | 'start' | 'target')[]
  accent: string; label: string; name: string; ready: boolean; settled?: boolean; error: boolean; onRetry: () => void
  drawing: ReactNode; moments?: ReactNode; notes: Note[]; spec: readonly Row[]
  fig2?: { node: ReactNode }; units: ReactNode
}) {
  // (each note, row and figure 2 says which parts it's about, for whoever reads the poster's markup; nothing
  // reacts to the pointer: a poster reads the same whether or not it's hovered)
  const point = (part: string) => ({ 'data-part': part })
  const stage = useRef<HTMLDivElement>(null)
  const strip = useContext(InStrip)
  const look = useContext(PosterStyleContext)
  const size = sheetSize(look.layout)
  const k = usePosterScale(stage, strip, size)
  const dark = theme === 'dark'
  useThemeRefresh(dark)
  useInter()
  // (one poster on its own is the page's main content; in the strip, the strip is, and each poster an article in it)
  const Root = strip ? 'article' : 'main'
  return (
    <Root className={styles.page} data-theme={theme} data-interface-bts data-in-strip={strip || undefined} data-settled={((settled ?? ready) && !error) || undefined} aria-label={label} aria-busy={!ready && !error}>
      {error && <div className={styles.error} role="alert"><p>The breakdown couldn&apos;t load.</p><button onClick={onRetry}>Try again</button></div>}
      <div ref={stage} className={styles.stage}>
      {/* (the poster's footprint at its scale, so the page lays out round what's drawn) */}
      <div style={{ width: size.w * k, height: size.h * k }}>
      {/* (unshown until ready by opacity, not visibility: a visibility-hidden component can't take focus, and menus
          move their highlight, and close their submenus, by focus) */}
      <div className={styles.sheet} data-poster data-layout={look.layout} data-font={look.font} style={{ ...accentVars(accent, dark, look.paper, look.accent), transform: `scale(${k})`, opacity: ready ? 1 : 0, pointerEvents: ready ? undefined : 'none' }}>
        <header className={styles.title}>
          <h1>{name}</h1>
        </header>

        <figure className={styles.figure}>
          <div className={styles.drawing} data-drawing>{drawing}</div>
          {moments}
        </figure>

        <div className={styles.foot} data-foot>
          <section className={styles.notes} aria-label="Notes">
            {notes.map((n, i) => <div key={i} className={styles.note} {...point(n.part)}><span className={styles.number}>{i + 1}</span><p><span>{n.head}</span> {n.body}</p></div>)}
          </section>
          <section className={styles.spec} aria-label="Specification">
            {[spec.slice(0, Math.ceil(spec.length / 2)), spec.slice(Math.ceil(spec.length / 2))].map((half, i) => <dl key={i}>{half.map(([k, v, part]) => <div key={k} className={styles.row} {...point(part)}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>)}
          </section>
          {fig2 && <figure className={styles.curveFigure} {...point('curve')}>
            {fig2.node}
          </figure>}
        </div>

        <footer className={styles.titleBlock} aria-label="Drawing details" data-title-block>
          <span>{units}</span>
          {lines.length > 0 && <span className={styles.lines}>
            {lines.includes('now') && <><i className={styles.lineNow} />Now</>}
            {lines.includes('start') && <><i className={styles.lineGhost} />Start</>}
            {lines.includes('target') && <><i className={styles.lineRef} />Target</>}
          </span>}
        </footer>
      </div>
      </div>
      </div>
    </Root>
  )
}
