# Inline widget design guide

This is the text the `widget_guide` tool returns to the agent before it draws a
widget. It translates Pipper's Fluid Functionalism system (see `design.md` and
`src/index.css`) into rules that work inside a sandboxed frame, where the agent
writes plain HTML/SVG and cannot import React components.

The guide is split into modules so the agent loads only what it needs:
`core` (always), `diagram`, `chart`, `table`, `interactive`. Everything below the
"Agent-facing text" line is returned verbatim.

## Host contract (not sent to the agent)

The frame must provide, before any widget code runs:

1. **Tokens.** The `:root` / `[data-workspace-theme]` blocks from `src/index.css`,
   generated at build time into `widget-frame.css`. Same variable names as the
   app, so a token change ships to widgets automatically.
2. **Theme scope.** `data-workspace-theme="light|dark"` on the frame root, updated
   via `postMessage` when the app theme changes. Widgets never read
   `prefers-color-scheme` themselves.
3. **Shape mode.** `data-shape="pill|rounded"` on the root, following the app's
   **R** toggle. `--ff-radius` resolves from it.
4. **Motion.** `--ff-ease-fast|moderate|slow` and `--ff-dur-fast|moderate|slow`,
   approximating `src/lib/springs.ts` (0.08s / 0.16s / 0.24s). Durations collapse
   to `0s` under `prefers-reduced-motion`.
5. **Fonts.** Inter Variable and JetBrains Mono Variable, self-hosted.
6. **Icons.** Phosphor regular icon font, exposed as `<i class="ph ph-NAME">`.
7. **Component kit.** The `.ff-*` classes listed below, implemented in
   `widget-frame.css` on top of the tokens.
8. **Runtime API.** `pipper.sendPrompt(text)`, `pipper.openLink(url)`. Height is
   measured by the host with a `ResizeObserver`; widgets never set it.
9. **CSP.** Scripts only from the frame origin and the CDN allowlist below.

---

## Agent-facing text

### core

You are drawing a widget that renders inline in a Pipper thread. It must look
like part of Pipper, not like an embedded web page. The user should not be able
to tell where the app ends and the widget begins.

**Output shape**

- Write an HTML fragment or a single `<svg>`. No `<!doctype>`, `<html>`,
  `<head>` or `<body>`.
- Order: one short `<style>` block, then content, then `<script>` last. The
  widget streams in; styles first keeps it looking finished mid-stream.
- Never set a height or width on the outer element. The host sizes the frame to
  your content. Fill the width (`width: 100%`); don't scroll internally.
- Start with `<h2 class="sr-only">` holding a one-sentence summary. For SVG, use
  `role="img"` with `<title>` and `<desc>`.
- Explanations go in your chat reply, not in the widget. The widget holds only
  the visual.

**Colour: tokens only**

Never write a hex, rgb or oklch value. Use these variables; they already
switch between light and dark.

| Role                        | Variable                             |
| --------------------------- | ------------------------------------ |
| Primary text                | `--foreground`                       |
| Secondary text, axis labels | `--muted-foreground`                 |
| Hairlines, gridlines        | `--border`                           |
| Card fill                   | `--card`                             |
| Row hover / selected        | `--hover` / `--active`               |
| Primary action              | `--primary` / `--primary-foreground` |
| Error                       | `--destructive`                      |
| Focus ring                  | `--ring`                             |

The outer background is always transparent. The host draws the thread behind
you.

**Status colours**

Pipper has five states. Use them only when the data means that state, never as
decoration or to tell series apart.

| State     | Meaning                 | Fill / text pair                                       | Badge pair                                                            |
| --------- | ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `neutral` | idle, unknown           | `--workspace-fill-neutral` / `--workspace-ink-neutral` | `--workspace-badge-surface-neutral` / `--workspace-badge-ink-neutral` |
| `action`  | needs attention         | `--workspace-fill-action` / `--workspace-ink-action`   | `…-badge-surface-action` / `…-badge-ink-action`                       |
| `ready`   | done, passing           | `--workspace-fill-ready` / `--workspace-ink-ready`     | `…-badge-surface-ready` / `…-badge-ink-ready`                         |
| `merged`  | complete, archived      | `--workspace-fill-merged` / `--workspace-ink-merged`   | `…-badge-surface-merged` / `…-badge-ink-merged`                       |
| `stale`   | outdated, informational | `--workspace-fill-stale` / `--workspace-ink-stale`     | `…-badge-surface-stale` / `…-badge-ink-stale`                         |

Always use a fill with its own ink. Never put `--foreground` on a state fill.
For a plain text accent, use `--workspace-tone-{state}`.

**Elevation**

Light mode shows depth with shadows only; dark mode with stepped surfaces.

- A card inside a widget: `.ff-card` (uses `--card` and `--shadow-2`).
- A card inside a card: `.ff-card` with `data-level="2"` (`--shadow-3`).
- Never put a background colour on the outermost element.
- No other shadows, no gradients, no blur, no glow.

**Shape**

Use `var(--ff-radius)` for controls and cards. It follows the user's pill or
rounded setting. Never hardcode a border radius on controls. In SVG, use
`rx="6"` for boxes.

**Type**

- Inter for text, JetBrains Mono for code, numbers in tables and IDs
  (`font-family: var(--font-mono)`).
- Sizes: 13px body, 12px secondary and labels, 15px for a single headline
  number or title. Nothing below 11px.
- Weights 400 and 500 only.
- Sentence case everywhere. No ALL CAPS, no Title Case.
- Use `font-variant-numeric: tabular-nums` for any column of numbers.

**Spacing**

A 4px grid: 4, 8, 12, 16, 24. 16px inside cards, 8px between related items,
16px between groups.

**Icons**

Phosphor only: `<i class="ph ph-check" aria-hidden="true"></i>`. 16px inline,
20px max. Icon-only buttons need `aria-label`. No emoji, no hand-drawn icon
paths.

**Motion**

- Animate only `transform` and `opacity`.
- Use `var(--ff-dur-moderate) var(--ff-ease-moderate)` for reveals and
  `--ff-*-fast` for hover. Don't write durations or easing curves by hand.
- No looping animation unless it shows the system's behaviour (data flow,
  progress).

**Components**

Build from these classes before writing your own styles:

| Class                                                | Use                                                      |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `.ff-card`                                           | Bounded group of content                                 |
| `.ff-stat`                                           | Number + label tile (`.ff-stat-value`, `.ff-stat-label`) |
| `.ff-badge[data-tone=STATE]`                         | Status pill using the badge pair                         |
| `.ff-table`                                          | Data table: hairline rows, mono numbers, hover wash      |
| `.ff-btn` / `.ff-btn[data-variant=secondary]`        | Buttons                                                  |
| `.ff-input`, `.ff-select`, `.ff-range`, `.ff-switch` | Controls                                                 |
| `.ff-row`, `.ff-stack`                               | Flex row / column with 8px gap (`data-gap="16"` for 16)  |
| `.sr-only`                                           | Screen-reader-only text                                  |

Example:

```html
<h2 class="sr-only">Test results: 412 passed, 3 failed.</h2>
<div class="ff-row" data-gap="16">
  <div class="ff-card ff-stat">
    <span class="ff-stat-label">Passed</span>
    <span class="ff-stat-value">412</span>
    <span class="ff-badge" data-tone="ready"
      ><i class="ph ph-check" aria-hidden="true"></i> Ready</span
    >
  </div>
  <div class="ff-card ff-stat">
    <span class="ff-stat-label">Failed</span>
    <span class="ff-stat-value">3</span>
    <span class="ff-badge" data-tone="action">Needs attention</span>
  </div>
</div>
```

**Interaction**

- `pipper.sendPrompt(text)` sends a message to the chat as if the user typed it.
  Use it when the next step needs you to think (e.g. "Explain this failure").
  Do filtering, sorting and toggles in JS instead.
- Links: plain `<a href>` is intercepted and confirmed by the host, or call
  `pipper.openLink(url)`.
- Validate input before acting on it; show errors inline in 12px
  `--destructive` text.

**Never**

- `position: fixed`, fullscreen APIs, `window.open`, `top` navigation.
- `localStorage` for anything that matters.
- Hidden tabs or `display: none` content during streaming.
- Nested scrolling.
- Any colour, shadow, radius or duration not taken from a variable.

**Libraries**

Scripts may load only from `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`,
`unpkg.com` and `esm.sh`, at an exact version. Other origins are blocked.

### chart

- Chart.js or D3. Read colours from CSS variables at runtime:
  `getComputedStyle(document.documentElement).getPropertyValue('--foreground')`.
  Re-read and redraw when the host posts a `theme` message.
- **Series colours:** use the data ramp `--ff-data-1` … `--ff-data-6`
  (graphite-based, distinct from status colours). Use a state colour only when a
  bar or point literally is that state.
- One series → `--ff-data-1`. Never cycle colours across the bars of a single
  series.
- Gridlines `--border`, axis text `--muted-foreground` at 12px, no chart border,
  no background.
- Pair colour with a second cue (dash pattern, marker shape, direct label) when
  there are 3+ series.
- Prefer direct labels over a legend for 1–3 series.
- Tooltips use `.ff-card` styling. Disable library animations or set them to
  `--ff-dur-moderate`.

### diagram

- SVG with `viewBox="0 0 680 H"`, `width="100%"`. Keep the 680 width so units
  match CSS pixels. Set H to the lowest element + 24px.
- Boxes: `fill="var(--card)"`, `stroke="var(--border)"`, `stroke-width="1"`,
  `rx="6"`. A box that is a state uses that state's fill and ink pair.
- Text: 13px `--foreground` for labels, 12px `--muted-foreground` for subtitles.
  Every text inside a box uses `dominant-baseline="central"`.
- Connectors: `stroke="var(--muted-foreground)"`, `fill="none"`, 1px, with the
  arrow marker using `stroke="context-stroke"`.
- At most four boxes per row and two colour families per diagram.
- Lines never cross boxes or text. Route around with L-shaped paths.
- Clickable boxes call `pipper.sendPrompt(...)` and get `cursor: pointer`.

### table

- Use `.ff-table`. Numbers right-aligned, mono, tabular.
- Status columns use `.ff-badge[data-tone]`, not coloured text.
- More than 12 rows: show 12 with a `.ff-btn[data-variant=secondary]` "Show all"
  toggle, rather than scrolling.
- Sort by clicking headers, handled in JS. Show the sort direction with
  `ph-caret-up` / `ph-caret-down`.

### interactive

- Controls go above or below the visual in a `.ff-row`, never on top of it.
- State changes are synchronous class or attribute flips. Don't rebuild a
  control's DOM with `innerHTML`; it drops its listeners.
- For an "expand" button, toggle a class that enlarges the content. There is no
  fullscreen.
- Steppers (for cycles or processes): one panel per stage, position dots, Next
  wraps from last to first.
