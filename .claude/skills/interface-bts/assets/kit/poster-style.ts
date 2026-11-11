'use client'

import { createContext } from 'react'

// Apple's system colours, from the Human Interface Guidelines: one set for macOS 26 and iOS 26 (updated June 2025),
// with a value for light and one for dark. Every accent on a poster is one of these, in the app's theme.
export const SYSTEM = {
  light: {
    red: '#FF383C', orange: '#FF8D28', yellow: '#FFCC00', green: '#34C759', mint: '#00C8B3', teal: '#00C3D0',
    cyan: '#00C0E8', blue: '#0088FF', indigo: '#6155F5', purple: '#CB30E0', pink: '#FF2D55', brown: '#AC7F5E',
  },
  dark: {
    red: '#FF4245', orange: '#FF9230', yellow: '#FFD600', green: '#30D158', mint: '#00DAC3', teal: '#00D2E0',
    cyan: '#3CD3FE', blue: '#0091FF', indigo: '#6D7CFF', purple: '#DB34F2', pink: '#FF375F', brown: '#B78A66',
  },
} as const
export type Swatch = keyof typeof SYSTEM.light
// Papers, beyond the poster's own (white, or black in dark): a pale grey, a mid grey (a technical poster's plate)
// and a blueprint blue, light to dark, each with its dark counterpart.
export const PAPER_TONES = {
  light: { mist: '#F4F5F7', plate: '#D4D5D7', blueprint: '#A2C7E2' },
  dark: { mist: '#373735', plate: '#363942', blueprint: '#1C5EAC' },
} as const
// A colour as the toolbar keeps it, by name (so it follows the theme) or as a hex the reader picked
export function colourOf(v: string | undefined, dark: boolean): string | undefined {
  if (!v || v.startsWith('#')) return v
  const mode = dark ? 'dark' : 'light'
  return (SYSTEM[mode] as Record<string, string>)[v] ?? (PAPER_TONES[mode] as Record<string, string>)[v]
}

// How the reader has set the posters up in the strip's toolbar: the paper, the accent, the orientation and the
// type. Unset (the default, and every poster on its own route) is the poster as the skill draws it.
export type PosterStyle = { paper?: string; accent?: string; layout: 'portrait' | 'landscape'; font: 'inter' | 'hand' }
export const DEFAULT_STYLE: PosterStyle = { layout: 'portrait', font: 'inter' }
export const PosterStyleContext = createContext<PosterStyle>(DEFAULT_STYLE)

// The handwritten face, from Google Fonts: loaded with the strip's toolbar
export const HAND_FONT = { family: 'Shantell Sans', css: 'https://fonts.googleapis.com/css2?family=Shantell+Sans:wght@400;500&display=swap' }

// --- colour: hex in, sRGB, OKLCH, and WCAG contrast

type RGB = [number, number, number]
export const hexToRgb = (hex: string): RGB | null => {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB
}
export const rgbToHex = (c: RGB) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
const luminance = (c: RGB) => { const [r, g, b] = c.map(toLinear); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
export const contrast = (a: RGB, b: RGB) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
// APCA (the perceptual contrast behind WCAG 3): how well text of one colour reads on another, as |Lc|, 0 to about
// 106. Unlike WCAG 2's ratio it weighs light text on a dark ground and dark on light differently, so on a mid blue
// it rightly prefers white (Lc 67 against black's 42, where the ratio says black).
export function apca(text: RGB, ground: RGB) {
  const y = ([r, g, b]: RGB) => { const v = 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4; return v < 0.022 ? v + (0.022 - v) ** 1.414 : v }
  const t = y(text), g = y(ground)
  const s = g > t ? (g ** 0.56 - t ** 0.57) * 1.14 : (g ** 0.65 - t ** 0.62) * 1.14
  return Math.abs(s) < 0.1 ? 0 : (Math.abs(s) - 0.027) * 100
}

function toOklch(c: RGB): [number, number, number] {
  const [r, g, b] = c.map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), Math.atan2(B, A)]
}
const linearOf = ([L, C, H]: [number, number, number]) => {
  const A = C * Math.cos(H), B = C * Math.sin(H)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}
// (a lightness the screen can't show at this chroma loses chroma, not hue: clipping each channel instead turns a
// light blue cyan)
function fromOklch([L, C, H]: [number, number, number]): RGB {
  const inside = (c: number) => linearOf([L, c, H]).every((v) => v >= -1e-4 && v <= 1 + 1e-4)
  let c = C
  if (!inside(c)) { let lo = 0, hi = C; for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inside(mid)) lo = mid; else hi = mid } c = lo }
  return linearOf([L, c, H]).map((v) => toGamma(Math.max(0, Math.min(1, v)))) as RGB
}

// The accent moved lighter or darker (away from the paper) until it reads against it at `target` (APCA Lc), keeping
// its hue; null when no lightness of it gets there.
function readable(accent: RGB, paper: RGB, target: number, lighter: boolean): RGB | null {
  if (apca(accent, paper) >= target) return accent
  const [L, C, H] = toOklch(accent)
  for (let i = 1; i <= 40; i++) {
    const l = lighter ? L + ((1 - L) * i) / 40 : L - (L * i) / 40
    const c = fromOklch([l, C, H])
    if (apca(c, paper) >= target) return c
  }
  return null
}

// The poster's colours for a paper and an accent. Words go black or white, whichever reads better on the paper by
// APCA, and every other grey (lines, grids, units) is mixed from that ink and the paper, so all of it keeps its
// contrast. Lines in the accent need Lc 40 against the paper and accent words Lc 60 (the accent is moved lighter or
// darker to get there); an accent too close to the paper for that is dropped, and the drawings go monochrome in the
// ink.
export function posterColours(paperHex: string, accentHex: string) {
  const paper = hexToRgb(paperHex) ?? [1, 1, 1], accent = hexToRgb(accentHex) ?? [0, 0.53, 1]
  const light = apca([1, 1, 1], paper) > apca([0, 0, 0], paper)
  const ink = light ? 'oklch(0.97 0 0)' : 'oklch(0.22 0 0)'
  const mix = (p: number) => `color-mix(in oklch, ${ink} ${p}%, ${paperHex})`
  const over = (p: number) => `color-mix(in oklch, ${ink} ${p}%, transparent)`
  // (on a coloured paper an accent tint would mix the two hues, blue into yellow making green: tints there are the
  // ink's, and the accent stays in the lines and words)
  const coloured = toOklch(paper)[1] > 0.04
  // (an accent the paper's own colour, or nearly, draws nothing apart from it however light or dark it's made: the
  // drawings go monochrome, as they do when no lightness of the accent reads)
  const [aL, aC, aH] = toOklch(accent), [pL, pC, pH] = toOklch(paper)
  const near = Math.hypot(aL - pL, aC * Math.cos(aH) - pC * Math.cos(pH), aC * Math.sin(aH) - pC * Math.sin(pH)) < 0.12
  const line = near ? null : readable(accent, paper, 40, light)
  const word = line && readable(line, paper, 60, light)
  const mono = !line || !word
  return {
    mono,
    vars: {
      '--paper': paperHex, '--ink': ink, '--muted': mix(66), '--dim': mix(74), '--faint': mix(42), '--line': mix(14), '--unit': mix(50), '--badge': mix(9),
      '--grid': over(6), '--grid-strong': over(9), '--band': over(5), '--hatch': over(18), '--edge': over(10),
      '--accent': mono ? ink : rgbToHex(line!), '--accent-tint': mono || coloured ? over(10) : `color-mix(in oklch, ${rgbToHex(line!)} 16%, ${paperHex})`, '--accent-ink': mono ? ink : rgbToHex(word!),
      colorScheme: light ? 'dark' : 'light',
    } as React.CSSProperties,
  }
}
