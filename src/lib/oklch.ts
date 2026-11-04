/**
 * Hex ⇄ OKLCH conversion, for tuning palette colours by lightness, chroma
 * (intensity) and hue the way the eye reads them rather than in RGB.
 */

export interface Rgba {
  /** Channels in 0..1. */
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Oklch {
  /** 0..1 */
  l: number;
  /** 0..~0.4 */
  c: number;
  /** Degrees, 0..360. */
  h: number;
}

/** Lightness shift (OKLCH L, -1..1), chroma multiplier, and hue rotation in degrees. */
export interface ColorAdjust {
  lightness: number;
  chroma: number;
  hue: number;
}

export const NO_ADJUST: ColorAdjust = { lightness: 0, chroma: 1, hue: 0 };

export function isNoAdjust(adjust: ColorAdjust): boolean {
  return adjust.lightness === 0 && adjust.chroma === 1 && adjust.hue === 0;
}

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa`; null for anything else. */
export function parseHex(input: string): Rgba | null {
  const hex = input.trim().replace(/^#/, "");
  if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;
  const channel = (index: number) => parseInt(full.slice(index, index + 2), 16) / 255;
  return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) : 1 };
}

/** `#rrggbb`, or `#rrggbbaa` when the colour is translucent. */
export function toHex({ r, g, b, a }: Rgba): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}${a < 1 ? channel(a) : ""}`;
}

const toLinear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const fromLinear = (value: number) =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

export function rgbToOklch({ r, g, b }: Rgba): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-6 ? 0 : (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c, h: (h + 360) % 360 };
}

/** sRGB channels, possibly outside 0..1 when the colour is out of gamut. */
function oklchToRgbUnclamped({ l: L, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const inGamut = (channels: number[]) =>
  channels.every((value) => value >= -1e-4 && value <= 1 + 1e-4);

/** Converts to sRGB, keeping lightness and hue and giving up chroma when out of gamut. */
export function oklchToRgb(color: Oklch, alpha = 1): Rgba {
  const l = Math.min(1, Math.max(0, color.l));
  let channels = oklchToRgbUnclamped({ ...color, l });
  if (!inGamut(channels)) {
    let low = 0;
    let high = color.c;
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToRgbUnclamped({ l, c: mid, h: color.h }))) low = mid;
      else high = mid;
    }
    channels = oklchToRgbUnclamped({ l, c: low, h: color.h });
  }
  const [r, g, b] = channels.map((value) => Math.min(1, Math.max(0, value)));
  return { r, g, b, a: alpha };
}

/** Shifts a hex colour's lightness, scales its chroma and rotates its hue. */
export function adjustHex(hex: string, adjust: ColorAdjust): string {
  const rgba = parseHex(hex);
  if (!rgba || isNoAdjust(adjust)) return hex.toLowerCase();
  const color = rgbToOklch(rgba);
  return toHex(
    oklchToRgb(
      {
        l: color.l + adjust.lightness,
        c: Math.max(0, color.c * adjust.chroma),
        h: (color.h + adjust.hue + 360) % 360,
      },
      rgba.a,
    ),
  );
}
