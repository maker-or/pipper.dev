# interface-bts

An agent skill that draws a **spec poster** of an interaction in your project: the real component paused at its key moments, with **dimensions**, the **easing curve**, a row of **moments** and a **specification**. Every value is read from the running component.

## Install

```bash
npx skills add nomanjack/interface-bts
```

The skills CLI needs Node 22 or later. On an older Node, run it through Node 22 without changing yours:

```bash
npx -p node@22 -p skills@latest skills add nomanjack/interface-bts
```

**React only, for now.** The kit is React with CSS modules (Next.js, Vite and the like). In another framework the agent can port the layout and the conventions, but there's no kit to copy yet.

## Use

Run it in your agent and name the interaction:

```text
/interface-bts the dropdown in components/menu.tsx
```

It studies the component, agrees the moments with you, then builds the poster in your project and checks it for overlaps by measurement. Every poster in the project is shown on one page, `/specs`, in a row you scroll sideways, with a toolbar to change the paper, the accent, portrait or landscape, Inter or handwritten type, and the theme when your app has a dark one.

To save the posters as images (PNG and WebP, A4, every moment, light and dark):

```bash
node scripts/capture.mjs http://localhost:3000/specs
```

That needs Playwright with Chromium in your project: `npm i -D playwright && npx playwright install chromium`.

## What's inside

- `SKILL.md`: the workflow and the poster's rules.
- `references/drafting.md`: dimension, line-type and view conventions.
- `references/drivers.md`: driving gestures, pointer paths, springs, and libraries that fight a scaled poster.
- `assets/kit/`: a React and CSS-modules kit for building posters.
- `assets/example/`: a finished poster of a copy button.
- `scripts/overlaps.js`: the overlap check.
- `scripts/capture.mjs`: saves every poster as images.

Posters are A4 (portrait, or landscape from the toolbar) and scale to fit; they follow your app's own theme.
