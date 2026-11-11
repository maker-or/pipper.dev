'use client'

import { Children, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_STYLE, PAPER_TONES, type PosterStyle, PosterStyleContext, SYSTEM } from './poster-style'
import { InStrip } from './spec-kit'
import { SpecToolbar } from './spec-toolbar'
import styles from './spec-strip.module.css'

// Every poster in the project on one page, side by side, scrolled sideways. Each keeps its own A4 layout and runs its
// own component; the row only sets the scale (the window's height, with a peek of the next poster) and the surround.
// A new poster is added here as well as to SPEC_ACCENTS.
//
// Its toolbar sets every poster's paper, accent, orientation and type, kept for the reader and written into the
// address, so a link (or scripts/capture.mjs) shows the same. Pass `onTheme`, the app's own theme switch, only when
// the app has a dark theme of its own; without it there's no theme control.
//
// Nothing is shown rearranging itself: each poster waits under a small spinner until it's ready and has stopped
// changing, then fades in, and a change of theme, orientation or type hides them all first, before anything moves.
//
// A mouse wheel moves it a poster at a time, a trackpad's sideways swipe scrolls it freely, and a finger snaps it a
// poster at a time. A poster's driver
// focusing its component (a menu item, an input) doesn't move it: the browser would scroll the row to the focus.
export function SpecStrip({ children, theme = 'light', onTheme, label = 'Spec posters' }: { children: ReactNode; theme?: 'light' | 'dark'; onTheme?: (theme: 'light' | 'dark') => void; label?: string }) {
  const row = useRef<HTMLElement>(null)
  const [look, setLook, loaded] = useLook()
  // (each bump hides every poster until it has settled again)
  const [epoch, setEpoch] = useState(0)
  const hold = () => setEpoch((e) => e + 1)
  const seen = useRef(theme)
  useLayoutEffect(() => { if (seen.current !== theme) { seen.current = theme; hold() } }, [theme])
  // (the reader's place: the poster at the row's start, put back there once the posters have their new size)
  const place = useRef(0)
  const startAt = () => {
    const el = row.current!, slots = [...el.querySelectorAll<HTMLElement>(':scope > [data-spec-slot]')]
    place.current = slots.reduce((b, s, i) => (Math.abs(s.offsetLeft - 21 - el.scrollLeft) < Math.abs(slots[b].offsetLeft - 21 - el.scrollLeft) ? i : b), 0)
  }
  useLayoutEffect(() => {
    const el = row.current, slot = el?.querySelectorAll<HTMLElement>(':scope > [data-spec-slot]')[place.current]
    if (el && slot) el.scrollLeft = slot.offsetLeft - 21
  }, [look.layout, look.font])
  // a change that moves things: hide, then make it once the posters are out of sight
  const change = (next: PosterStyle) => {
    if (next.layout === look.layout && next.font === look.font) return setLook(next)
    startAt(); hold(); setTimeout(() => setLook(next), HIDDEN)
  }
  const changeTheme = onTheme && ((t: 'light' | 'dark') => { hold(); setTimeout(() => onTheme(t), HIDDEN) })
  useEffect(() => {
    const el = row.current!
    // (when the reader last did something that scrolls, and where the row was left)
    // (the row starts at its start: posters' drivers run before this does, and may already have scrolled it)
    let user = -Infinity, focused = -Infinity, kept = 0, last = 0
    el.scrollLeft = 0
    // (the reader's own input only: drivers send synthetic pointer and key events of their own)
    const touched = (e: Event) => { if (e.isTrusted) user = performance.now() }
    const go = (d: number) => {
      const slots = [...el.querySelectorAll<HTMLElement>(':scope > [data-spec-slot]')]
      const at = el.scrollLeft + 21
      const now = slots.reduce((b, s, i) => (Math.abs(s.offsetLeft - at) < Math.abs(slots[b].offsetLeft - at) ? i : b), 0)
      const to = slots[Math.max(0, Math.min(slots.length - 1, now + d))]
      user = performance.now() + 600
      el.scrollTo({ left: to.offsetLeft - 21, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
    const wheel = (e: WheelEvent) => {
      // (an up-and-down wheel only; one gesture, however many events it sends, is one poster)
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) { touched(e); return }
      if (!e.isTrusted) return
      e.preventDefault()
      const t = performance.now()
      if (t - last > 200) go(Math.sign(e.deltaY))
      last = t
    }
    // (a scroll straight after a focus the reader didn't make is put back)
    const focus = () => { focused = performance.now() }
    const scroll = () => {
      const t = performance.now()
      if (t - focused < 150 && t - user > 1000) el.scrollLeft = kept
      else kept = el.scrollLeft
    }
    const opts = { capture: true, passive: true }
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('scroll', scroll, { passive: true })
    el.addEventListener('focusin', focus, true)
    for (const ev of ['pointerdown', 'touchstart', 'keydown'] as const) el.addEventListener(ev, touched, opts)
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('scroll', scroll)
      el.removeEventListener('focusin', focus, true)
      for (const ev of ['pointerdown', 'touchstart', 'keydown'] as const) el.removeEventListener(ev, touched, opts)
    }
  }, [])
  return (
    <main ref={row} className={styles.strip} data-theme={theme} data-spec-strip aria-label={label}>
      <InStrip.Provider value={true}>
        <PosterStyleContext.Provider value={look}>
          {Children.map(children, (poster) => <Slot epoch={epoch}>{poster}</Slot>)}
        </PosterStyleContext.Provider>
      </InStrip.Provider>
      <SpecToolbar look={look} onLook={change} theme={theme} onTheme={changeTheme} loaded={loaded} />
    </main>
  )
}

// The toolbar's settings: from the address first, then what this reader picked last, then the defaults. A change
// is written to both, and once the posters have laid out again, a resize is announced: components placed by
// floating-ui, or measuring themselves on screen, only look again on a resize.
const KEY = 'interface-bts-look'
const PARAMS = ['paper', 'accent', 'layout', 'font'] as const
function useLook(): [PosterStyle, (next: PosterStyle) => void, boolean] {
  const [look, setLook] = useState<PosterStyle>(DEFAULT_STYLE)
  // (false until the address and the reader's last choice have been read: the toolbar waits for it)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    let stored: Partial<PosterStyle> = {}
    try { stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch {}
    const fromUrl = Object.fromEntries(PARAMS.filter((k) => q.has(k)).map((k) => [k, q.get(k)!]))
    setLook(clean({ ...DEFAULT_STYLE, ...(Object.keys(fromUrl).length ? fromUrl : stored) }))
    setLoaded(true)
  }, [])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))))
    return () => cancelAnimationFrame(id)
  }, [look.layout, look.font])
  const set = (next: PosterStyle) => {
    const c = clean(next)
    setLook(c)
    try { localStorage.setItem(KEY, JSON.stringify(c)) } catch {}
    const q = new URLSearchParams(location.search)
    for (const k of PARAMS) { const v = c[k]; if (v && v !== DEFAULT_STYLE[k as 'layout' | 'font']) q.set(k, v); else q.delete(k) }
    history.replaceState(history.state, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`)
  }
  return [look, set, loaded]
}
// (only what the toolbar can set: a colour by name or as hex, or one of the options)
// (any system colour or paper tone by name, so a saved choice survives a change to the rows)
const NAMES = [...Object.keys(SYSTEM.light), ...Object.keys(PAPER_TONES.light)]
const colour = (v: unknown) => (typeof v !== 'string' ? undefined : NAMES.includes(v) ? v : /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined)
const clean = (v: Partial<PosterStyle>): PosterStyle => ({
  paper: colour(v.paper), accent: colour(v.accent),
  layout: v.layout === 'landscape' ? 'landscape' : 'portrait', font: v.font === 'hand' ? 'hand' : 'inter',
})

// One poster's place in the row. It shows once its poster has settled (ready, and its driver done) and nothing in it
// has changed for a moment, or after 15s whatever happens; until then, a spinner.
// (the fade out takes 160ms; the change waits a little past it, so not one frame of it shows)
const HIDDEN = 240
function Slot({ epoch, children }: { epoch: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  // (hidden before the frame that would show the change)
  useLayoutEffect(() => setShown(false), [epoch])
  useEffect(() => {
    const el = ref.current!
    let alive = true, quiet: ReturnType<typeof setTimeout> | undefined
    const done = () => { if (alive) setShown(true); mo.disconnect() }
    const check = () => {
      clearTimeout(quiet)
      quiet = setTimeout(() => (el.querySelector('[data-interface-bts][data-settled]') ? done() : check()), 400)
    }
    const mo = new MutationObserver(check)
    mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true })
    const cap = setTimeout(done, 15000)
    check()
    return () => { alive = false; mo.disconnect(); clearTimeout(quiet); clearTimeout(cap) }
  }, [epoch])
  return (
    <div ref={ref} className={styles.slot} data-spec-slot data-shown={shown || undefined} aria-busy={!shown}>
      {children}
      <span className={styles.loader} aria-hidden="true" />
    </div>
  )
}
