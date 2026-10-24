import { WIDGET_SCRIPT_ORIGINS } from "./widget-frame-origins.ts";

/**
 * Checks on widget source text, before it runs. They mirror the "never" list
 * in the design guide (`docs/inline-widgets/design-guide.md`); the in-frame
 * checks in `widget-frame.ts` cover what only rendering can show (overflow,
 * text size, contrast).
 */

export interface LintFinding {
  rule: string;
  message: string;
  line?: number;
}

const HEX_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(\s*[\d.]/gi;
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

export function lintWidgetSource(code: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = code.split("\n");
  const add = (rule: string, message: string, line?: number) => {
    if (findings.length < 30) findings.push({ rule, message, ...(line ? { line } : {}) });
  };

  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(code)) {
    add("document-wrapper", "Send a fragment: no <!doctype>, <html>, <head> or <body>.");
  }

  lines.forEach((text, index) => {
    const line = index + 1;
    for (const match of text.matchAll(HEX_COLOR)) {
      const before = text.slice(0, match.index);
      if (/(?:href|xlink:href)\s*=\s*["']$/i.test(before) || /url\(\s*["']?$/i.test(before))
        continue;
      add(
        "hardcoded-color",
        `${match[0]} on line ${line}; use a token such as var(--foreground).`,
        line,
      );
    }
    for (const match of text.matchAll(COLOR_FUNCTION)) {
      add("hardcoded-color", `${match[0]}…) on line ${line}; use a token instead.`, line);
    }
    if (/position\s*:\s*fixed/i.test(text)) {
      add(
        "fixed-position",
        `position: fixed on line ${line}; the frame sizes to in-flow content.`,
        line,
      );
    }
    if (/\b(?:request|exit)Fullscreen\b|fullscreenElement/.test(text)) {
      add("fullscreen", `Fullscreen API on line ${line}; toggle an expanded layout instead.`, line);
    }
    if (/\bwindow\.open\s*\(|\btop\.location\b|\bparent\.location\b/.test(text)) {
      add("navigation", `Line ${line} opens or navigates windows; use pipper.openLink(url).`, line);
    }
    if (/\b(?:localStorage|sessionStorage)\b/.test(text)) {
      add("storage", `Line ${line} uses browser storage, which widgets can't rely on.`, line);
    }
    if (/font-weight\s*:\s*(?:[6-9]00|bold(?:er)?)\b/i.test(text)) {
      add("font-weight", `Line ${line} uses a heavy weight; use 400 or 500.`, line);
    }
  });

  for (const match of code.matchAll(SCRIPT_SRC)) {
    const src = match[1];
    let origin: string | null = null;
    try {
      origin = new URL(src).origin;
    } catch {
      origin = null;
    }
    if (!origin || !WIDGET_SCRIPT_ORIGINS.includes(origin)) {
      add("script-origin", `${src} isn't on an allowed CDN (${WIDGET_SCRIPT_ORIGINS.join(", ")}).`);
    } else if (!/@\d+\.\d+\.\d+/.test(src) && !/\/\d+\.\d+\.\d+\//.test(src)) {
      add("unpinned-script", `${src} has no exact version; pin one, e.g. chart.js@4.4.1.`);
    }
  }

  return findings;
}
