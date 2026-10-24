import phosphorCss from "@phosphor-icons/web/regular/style.css?raw";
import phosphorFont from "@phosphor-icons/web/regular/Phosphor.woff2?inline";
import appCss from "../../src/index.css?raw";
import { WIDGET_SCRIPT_ORIGINS } from "./widget-frame-origins.ts";
import { extractThemeTokens } from "./widget-tokens.ts";

/**
 * The document every inline widget renders in: Pipper's theme tokens, the
 * `.ff-*` component kit, and a small runtime (`window.pipper`, rendering,
 * in-frame design checks). `preview_widget` loads it in a headless page;
 * the thread's widget frame is meant to load the same document.
 */

/** Phosphor's icon classes with the font inlined, so icons never wait on a CDN. */
function phosphorStyles(): string {
  return phosphorCss.replace(
    /src:\s*url\("\.\/Phosphor\.woff2"\)[^;]*;/,
    `src: url("${phosphorFont}") format("woff2");`,
  );
}

const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${WIDGET_SCRIPT_ORIGINS.join(" ")}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com",
  "img-src data: blob: https:",
  `connect-src ${WIDGET_SCRIPT_ORIGINS.join(" ")}`,
].join("; ");

/** Data-series colours, kept apart from the five Git-state colours. */
const DATA_RAMP = `
[data-workspace-theme="light"] {
  --ff-data-1: #4b5563; --ff-data-2: #2b7a8c; --ff-data-3: #b05a6e;
  --ff-data-4: #6f7d3a; --ff-data-5: #8a6f4e; --ff-data-6: #5b6fae;
}
[data-workspace-theme="dark"] {
  --ff-data-1: #a1a1aa; --ff-data-2: #5fb7c9; --ff-data-3: #e08aa0;
  --ff-data-4: #a9b86a; --ff-data-5: #c9a77f; --ff-data-6: #93a6e3;
}`;

const KIT_CSS = `
:root {
  --font-sans: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace;
  --ff-radius: 10px;
  --ff-ease-fast: cubic-bezier(0.2, 0, 0, 1);
  --ff-ease-moderate: cubic-bezier(0.25, 0.1, 0.1, 1.05);
  --ff-ease-slow: cubic-bezier(0.3, 0.1, 0.1, 1.08);
  --ff-dur-fast: 0.08s;
  --ff-dur-moderate: 0.16s;
  --ff-dur-slow: 0.24s;
}
:root[data-shape="pill"] { --ff-radius: 999px; }
@media (prefers-reduced-motion: reduce) {
  :root { --ff-dur-fast: 0s; --ff-dur-moderate: 0s; --ff-dur-slow: 0s; }
}
html, body { margin: 0; padding: 0; background: transparent; }
body {
  font-family: var(--font-sans); font-size: 13px; line-height: 1.6;
  color: var(--foreground); -webkit-font-smoothing: antialiased;
}
#widget-root { width: var(--frame-width, 680px); overflow: hidden; }
h1, h2, h3 { font-weight: 500; margin: 0 0 8px; color: var(--foreground); }
h1 { font-size: 15px; } h2 { font-size: 14px; } h3 { font-size: 13px; }
a { color: var(--workspace-tone-stale); }
code, pre, kbd { font-family: var(--font-mono); font-size: 12px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.ff-row { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
.ff-stack { display: flex; flex-direction: column; gap: 8px; }
.ff-row[data-gap="16"], .ff-stack[data-gap="16"] { gap: 16px; }
.ff-row[data-gap="4"], .ff-stack[data-gap="4"] { gap: 4px; }
.ff-card {
  background: var(--card); border-radius: 12px; padding: 16px;
  box-shadow: var(--shadow-2); min-width: 0;
}
.ff-card[data-level="2"] { box-shadow: var(--shadow-3); }
.ff-row > .ff-card { flex: 1 1 0; }
.ff-stat { display: flex; flex-direction: column; gap: 4px; }
.ff-stat-label { font-size: 12px; color: var(--muted-foreground); }
.ff-stat-value {
  font-size: 15px; font-weight: 500; color: var(--foreground);
  font-variant-numeric: tabular-nums;
}
.ff-badge {
  display: inline-flex; align-items: center; gap: 4px; align-self: flex-start;
  padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500;
  background: var(--workspace-badge-surface-neutral); color: var(--workspace-badge-ink-neutral);
}
${["neutral", "action", "ready", "merged", "stale"]
  .map(
    (tone) =>
      `.ff-badge[data-tone="${tone}"] { background: var(--workspace-badge-surface-${tone}); color: var(--workspace-badge-ink-${tone}); }\n` +
      // The app's dark badge pairs sit below 4.5:1; small badge text needs the fill/ink pair.
      `[data-workspace-theme="dark"] .ff-badge[data-tone="${tone}"] { background: var(--workspace-fill-${tone}); color: var(--workspace-ink-${tone}); }`,
  )
  .join("\n")}
.ff-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ff-table th {
  text-align: left; font-weight: 500; font-size: 12px; color: var(--muted-foreground);
  padding: 8px; border-bottom: 1px solid var(--border);
}
.ff-table td { padding: 8px; border-bottom: 1px solid var(--border); }
.ff-table tr:last-child td { border-bottom: 0; }
.ff-table tbody tr:hover td { background: var(--hover); }
.ff-table td[data-num], .ff-table th[data-num] {
  text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
}
.ff-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
  border: 0; border-radius: var(--ff-radius); font: inherit; font-weight: 500; cursor: pointer;
  background: var(--primary); color: var(--primary-foreground);
  transition: transform var(--ff-dur-fast) var(--ff-ease-fast), opacity var(--ff-dur-fast) var(--ff-ease-fast);
}
.ff-btn:active { transform: scale(0.97); }
.ff-btn[data-variant="secondary"] { background: var(--accent); color: var(--accent-foreground); }
.ff-btn:focus-visible, .ff-input:focus-visible, .ff-select:focus-visible {
  outline: 2px solid var(--ring); outline-offset: 2px;
}
.ff-input, .ff-select {
  height: 30px; padding: 0 10px; border-radius: var(--ff-radius); font: inherit;
  border: 1px solid var(--border); background: var(--card); color: var(--foreground);
}
.ff-range { width: 100%; accent-color: var(--primary); }
.ff-switch { appearance: none; width: 34px; height: 20px; border-radius: 999px;
  background: var(--border); position: relative; cursor: pointer; margin: 0;
  transition: background var(--ff-dur-fast) var(--ff-ease-fast); }
.ff-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--card); box-shadow: var(--shadow-2);
  transition: transform var(--ff-dur-moderate) var(--ff-ease-moderate); }
.ff-switch:checked { background: var(--primary); }
.ff-switch:checked::after { transform: translateX(14px); }
.ff-error { font-size: 12px; color: var(--destructive); }
.ph { font-size: 16px; vertical-align: -2px; }
`;

/** Runs inside the frame. Kept dependency-free and ES2020. */
const RUNTIME = String.raw`
(() => {
  const root = document.getElementById("widget-root");
  const errors = [];
  const blocked = [];
  const actions = [];
  window.addEventListener("error", (event) => {
    if (event.target && event.target !== window && event.target.src) {
      blocked.push({ url: event.target.src, reason: "failed to load" });
      return;
    }
    errors.push(String(event.message || event.error));
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason && event.reason.message ? event.reason.message : event.reason;
    errors.push("Unhandled rejection: " + String(reason));
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    blocked.push({ url: event.blockedURI, reason: "blocked by " + event.effectiveDirective });
  });
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map((arg) => (arg && arg.message) || String(arg)).join(" "));
    originalError(...args);
  };

  const post = (message) => {
    actions.push(message);
    if (window.parent !== window) window.parent.postMessage({ source: "pipper-widget", ...message }, "*");
  };
  window.pipper = {
    sendPrompt: (text) => post({ type: "sendPrompt", text: String(text) }),
    openLink: (url) => post({ type: "openLink", url: String(url) }),
  };
  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    event.preventDefault();
    window.pipper.openLink(link.href);
  });

  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const loadScript = (original) => new Promise((resolve) => {
    const script = document.createElement("script");
    for (const attr of original.attributes) script.setAttribute(attr.name, attr.value);
    script.textContent = original.textContent;
    if (!original.src || script.type === "module") {
      original.replaceWith(script);
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 10000);
    script.onload = script.onerror = () => { clearTimeout(timer); resolve(); };
    original.replaceWith(script);
  });

  window.__pipperRender = async (code, options) => {
    document.documentElement.style.setProperty("--frame-width", options.width + "px");
    document.documentElement.dataset.workspaceTheme = options.theme;
    const template = document.createElement("template");
    template.innerHTML = code;
    root.replaceChildren(template.content);
    for (const script of Array.from(root.querySelectorAll("script"))) await loadScript(script);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Icon and web fonts come from a CDN; don't let a slow network stall the render.
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    await frames();
    return window.__pipperState();
  };

  window.__pipperSetTheme = async (theme) => {
    document.documentElement.dataset.workspaceTheme = theme;
    await frames();
    return window.__pipperState();
  };

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgbaCache = new Map();
  const toRgba = (color) => {
    if (rgbaCache.has(color)) return rgbaCache.get(color);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const value = [d[0], d[1], d[2], d[3] / 255];
    rgbaCache.set(color, value);
    return value;
  };
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const luminance = (rgb) => {
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const pageBackground = () =>
    toRgba(getComputedStyle(document.documentElement).getPropertyValue("--background").trim() || "white");
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const bg = toRgba(getComputedStyle(node).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let result = pageBackground();
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result);
    return result;
  };
  const ownText = (element) => {
    let text = "";
    for (const child of element.childNodes) if (child.nodeType === 3) text += child.textContent;
    return text.replace(/\s+/g, " ").trim();
  };

  window.__pipperState = () => {
    const lint = [];
    const push = (rule, message) => { if (lint.length < 20) lint.push({ rule, message }); };
    const rootRect = root.getBoundingClientRect();
    if (root.scrollWidth > root.clientWidth + 1) {
      push("content-overflow", "Content is " + root.scrollWidth + "px wide but the frame is " + root.clientWidth + "px.");
    }
    const elements = Array.from(root.querySelectorAll("*")).slice(0, 3000);
    const seen = new Set();
    for (const element of elements) {
      const style = getComputedStyle(element);
      if (style.position === "fixed") push("fixed-position", "<" + element.tagName.toLowerCase() + "> uses position: fixed.");
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1) {
        push("nested-scroll", "<" + element.tagName.toLowerCase() + "> scrolls internally; let the content grow instead.");
      }
      const text = ownText(element);
      if (!text || style.visibility === "hidden" || style.display === "none" || element.closest(".sr-only")) continue;
      const size = parseFloat(style.fontSize);
      if (size < 11 && !seen.has("small:" + size)) {
        seen.add("small:" + size);
        push("small-text", "Text \"" + text.slice(0, 40) + "\" is " + size + "px; the minimum is 11px.");
      }
      const weight = parseInt(style.fontWeight, 10);
      if (weight >= 600 && !seen.has("weight")) {
        seen.add("weight");
        push("font-weight", "Text \"" + text.slice(0, 40) + "\" uses weight " + weight + "; use 400 or 500.");
      }
      const fg = toRgba(style.color);
      const bg = backgroundOf(element);
      const ratio = contrast(over(fg, bg), bg);
      const large = size >= 24 || (size >= 18.66 && weight >= 600);
      const needed = large ? 3 : 4.5;
      if (ratio < needed && !seen.has("contrast:" + style.color)) {
        seen.add("contrast:" + style.color);
        push("low-contrast", "Text \"" + text.slice(0, 40) + "\" has contrast " + ratio.toFixed(2) + ":1; needs " + needed + ":1.");
      }
    }
    return {
      size: { width: Math.ceil(rootRect.width), height: Math.ceil(Math.max(root.scrollHeight, rootRect.height)) },
      errors: errors.slice(0, 20),
      blocked: blocked.slice(0, 20),
      actions: actions.slice(0, 20),
      lint,
    };
  };
})();
`;

let cachedHtml: string | null = null;

export function buildWidgetFrameHtml(): string {
  if (cachedHtml) return cachedHtml;
  const tokens = extractThemeTokens(appCss);
  cachedHtml = `<!doctype html>
<html data-workspace-theme="light" data-shape="rounded">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
${phosphorStyles()}
${tokens}
${DATA_RAMP}
${KIT_CSS}
</style>
</head>
<body><div id="widget-root"></div><script>${RUNTIME}</script></body>
</html>`;
  return cachedHtml;
}
