#!/usr/bin/env node
// capture.mjs: save every spec poster on a page as images, at A4 proportions, in each theme, at each moment.
//
//   node .claude/skills/interface-bts/scripts/capture.mjs http://localhost:3000/specs
//   node .claude/skills/interface-bts/scripts/capture.mjs http://localhost:3000/specs --themes light,dark --scale 2 --out specs-out
//
// Run it from the project's root (the path is wherever the skill is installed); images land in ./specs-out.
//
// It opens the page (the strip of all posters, or one poster's own page), waits until every poster is ready, and
// for each one saves the poster as it opens (its hero moment), then each moment in its row. Files are named
// <poster>-<theme>.png and <poster>-<theme>-<n>-<moment>.png, and the same with .webp.
//
// Themes are set the way most apps follow them, through the system's colour scheme. An app that keeps its own
// choice can be told it before each load with --theme-init, a line of JavaScript in which THEME stands for
// 'light' or 'dark':
//   --theme-init "localStorage.setItem('theme', THEME)"
//
// Needs Playwright with Chromium in the project: npm i -D playwright && npx playwright install chromium
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
if (!url) { console.error('Usage: node capture.mjs <url> [--themes light,dark] [--scale 2] [--formats png,webp] [--out specs-out] [--theme-init "<js>"]'); process.exit(1) }
const themes = opt('themes', 'light,dark').split(',')
const scale = Number(opt('scale', '2'))
const formats = opt('formats', 'png,webp').split(',')
const out = opt('out', 'specs-out')
const themeInit = opt('theme-init', '')
const A4W = 794

// (Playwright from the project it's run in, wherever the skill itself is installed: a project's own folder, or
// ~/.claude/skills)
let chromium
const fromProject = createRequire(join(process.cwd(), 'package.json'))
for (const name of ['playwright', 'playwright-core']) {
  // (loaded by path, its CommonJS exports may come as the default export)
  try { const m = await import(pathToFileURL(fromProject.resolve(name)).href); chromium = m.chromium ?? m.default?.chromium; if (chromium) break } catch {}
}
if (!chromium) { console.error('Playwright is needed in this project: npm i -D playwright && npx playwright install chromium'); process.exit(1) }

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const browser = await chromium.launch()
await mkdir(out, { recursive: true })
const saved = []

// a page in a theme, every poster ready
async function open(theme, deviceScaleFactor) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, deviceScaleFactor })
  if (themeInit) await context.addInitScript(`try{${themeInit.replaceAll('THEME', JSON.stringify(theme))}}catch(e){}`)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => {
    const all = [...document.querySelectorAll('[data-interface-bts]')]
    // (and, on the page of all posters, each one settled and shown)
    const slots = [...document.querySelectorAll('[data-spec-slot]')]
    return all.length > 0 && all.every((p) => p.getAttribute('aria-busy') === 'false') && slots.every((s) => s.hasAttribute('data-shown'))
  }, null, { timeout: 120000 })
  await settle(page)
  return { context, page, errors }
}

// until nothing on the posters has changed for half a second: drivers that capture after they're ready, a moment
// gliding into place
async function settle(page) {
  let last = '', same = 0
  for (let i = 0; i < 300 && same < 5; i++) {
    await page.waitForTimeout(100)
    const now = await page.evaluate(() => [...document.querySelectorAll('[data-poster]')].map((p) => p.innerHTML.length + (p.querySelector('[aria-label^="At "]')?.getAttribute('aria-label') ?? '')).join('|'))
    same = now === last ? same + 1 : 0
    last = now
  }
}

async function save(page, poster, name) {
  // (the pointer off every poster, so no note is hovered)
  await page.mouse.move(0, 0)
  await poster.scrollIntoViewIfNeeded()
  // (the page's own fixed chrome, a theme switch or a dev tools badge, kept off the shot; anything fixed inside a
  // poster, a toaster say, is the component and stays)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *, nextjs-portal')) {
      if (el.closest('[data-poster]') || el.querySelector('[data-poster]')) continue
      const p = getComputedStyle(el).position
      if ((p === 'fixed' || p === 'sticky' || el.tagName === 'NEXTJS-PORTAL') && !el.hasAttribute('data-capture-hidden')) { el.setAttribute('data-capture-hidden', ''); el.style.setProperty('visibility', 'hidden', 'important') }
    }
  })
  // (animations left as they are: the poster holds its component's real animations paused mid-run, and finishing
  // them would lose the moment)
  const png = await poster.screenshot()
  for (const f of formats) {
    const file = join(out, `${name}.${f}`)
    if (f === 'png') await writeFile(file, png)
    else if (f === 'webp') {
      // (encoded by the browser itself, so nothing else needs installing)
      const b64 = await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(s)
      }, png.toString('base64'))
      await writeFile(file, Buffer.from(b64, 'base64'))
    } else continue
    saved.push(file)
  }
}

for (const theme of themes) {
  // the posters' scale on this page, so the shots can be taken at `scale` × A4 whatever the page fits them to
  const probe = await open(theme, 1)
  const k = await probe.page.evaluate((w) => document.querySelector('[data-poster]').getBoundingClientRect().width / w, A4W)
  await probe.context.close()

  const { context, page, errors } = await open(theme, scale / k)
  const posters = await page.$$('[data-poster]')
  for (const poster of posters) {
    const name = slug(await poster.$eval('h1', (h) => h.textContent ?? 'poster'))
    await save(page, poster, `${name}-${theme}`)
    const moments = await poster.$$('[aria-label="Captured states"] button')
    const opened = await poster.$$eval('[aria-label="Captured states"] button', (bs) => bs.findIndex((b) => b.getAttribute('aria-pressed') === 'true'))
    for (const [i, button] of moments.entries()) {
      const label = slug((await button.getAttribute('aria-label'))?.split(',')[0] ?? `moment-${i + 1}`)
      await button.click()
      await settle(page)
      await save(page, poster, `${name}-${theme}-${i + 1}-${label}`)
    }
    // (back to the moment it opened on)
    if (opened >= 0 && moments[opened]) { await moments[opened].click(); await settle(page) }
  }
  if (errors.length) console.error(`${theme}: the page logged errors while capturing (check the shots):\n  ${errors.join('\n  ')}`)
  await context.close()
}

await browser.close()
console.log(`${saved.length} files in ${out}/`)
for (const f of saved) console.log(`  ${f}`)
