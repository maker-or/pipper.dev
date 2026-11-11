'use client'

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { colourOf, hexToRgb, HAND_FONT, PAPER_TONES, type PosterStyle, rgbToHex, SYSTEM } from './poster-style'
import styles from './spec-toolbar.module.css'

// The strip's toolbar: the paper, the accent, the theme (only when the app has a dark theme of its own), the
// orientation and the type. Every change shows at once on every poster.

// (by name: each shows, and is drawn in, its light or dark value with the theme. Four papers with the poster's own,
// six accents with each poster's own, and any other colour, any system colour included, through the plus)
export const PAPERS = ['mist', 'plate', 'blueprint'] as const satisfies readonly (keyof typeof PAPER_TONES.light)[]
export const ACCENTS = ['blue', 'orange', 'green', 'purple', 'red'] as const satisfies readonly (keyof typeof SYSTEM.light)[]

export function SpecToolbar({ look, onLook, theme, onTheme, loaded = true }: {
  look: PosterStyle; onLook: (next: PosterStyle) => void
  theme: 'light' | 'dark'; onTheme?: (theme: 'light' | 'dark') => void; loaded?: boolean
}) {
  const set = (part: Partial<PosterStyle>) => onLook({ ...look, ...part })

  // (on a narrow screen the row scrolls sideways; its ends fade only where there's more to see)
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bar.current!
    const edges = () => {
      el.toggleAttribute('data-more-left', el.scrollLeft > 1)
      el.toggleAttribute('data-more-right', el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
    }
    edges()
    el.addEventListener('scroll', edges, { passive: true })
    const ro = new ResizeObserver(edges); ro.observe(el)
    return () => { el.removeEventListener('scroll', edges); ro.disconnect() }
  }, [])
  // Nothing moves into place in view: the toolbar shows once the reader's choices are read and its type has loaded
  // (the Hand option is set in its own face), already showing them, and its transitions start a frame after that.
  const [shown, setShown] = useState(false)
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!loaded) return
    let alive = true
    void Promise.race([handFont(), new Promise((r) => setTimeout(r, 1200))]).then(() => {
      if (!alive) return
      setShown(true)
      requestAnimationFrame(() => requestAnimationFrame(() => alive && setLive(true)))
    })
    return () => { alive = false }
  }, [loaded])
  return (
    <div ref={bar} className={styles.toolbar} role="toolbar" aria-label="Poster style" data-shown={shown || undefined} data-live={live || undefined}>
      <Group label="Paper">
        <Swatches label="Paper" value={look.paper} onChange={(paper) => set({ paper })} names={PAPERS} dark={theme === 'dark'} auto={theme === 'dark' ? '#000000' : '#ffffff'} autoLabel={theme === 'dark' ? 'Black' : 'White'} />
      </Group>
      <Group label="Accent">
        <Swatches label="Accent" value={look.accent} onChange={(accent) => set({ accent })} names={ACCENTS} dark={theme === 'dark'} autoLabel="Each poster's own colour" />
      </Group>
      {/* (these three say what they are by their icons and names, so they go unlabelled) */}
      {onTheme && <Segmented label="Theme" value={theme} onChange={onTheme} options={[{ value: 'light', label: 'Light', icon: <Sun /> }, { value: 'dark', label: 'Dark', icon: <Moon /> }]} />}
      <Segmented label="Layout" value={look.layout} onChange={(layout) => set({ layout })} options={[{ value: 'portrait', label: 'Portrait', icon: <Sheet w={9} h={12} /> }, { value: 'landscape', label: 'Landscape', icon: <Sheet w={12} h={9} /> }]} />
      <Segmented label="Type" value={look.font} onChange={(font) => set({ font })} options={[{ value: 'inter', label: 'Inter' }, { value: 'hand', label: 'Hand', font: `'${HAND_FONT.family}', cursive` }]} text />
      <Tip bar={bar} />
    </div>
  )
}

// The name of whatever control without words of its own is under the pointer or has focus (a swatch, an icon),
// just above the toolbar. The first waits a moment; moving along the toolbar after that, it follows at once, until
// the pointer has been off it for a while.
function Tip({ bar }: { bar: React.RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<{ text: string; x: number; bottom: number } | null>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = bar.current!
    let wait: ReturnType<typeof setTimeout> | undefined, cool: ReturnType<typeof setTimeout> | undefined, warm = false
    const show = (b: HTMLElement) => {
      const text = b.getAttribute('aria-label')
      if (!text || b.textContent?.trim()) return hide()
      const r = b.getBoundingClientRect(), t = el.getBoundingClientRect()
      clearTimeout(cool); clearTimeout(wait)
      const go = () => { warm = true; setTip({ text, x: r.left + r.width / 2, bottom: innerHeight - t.top + 8 }); setShown(true) }
      if (warm) go(); else wait = setTimeout(go, 500)
    }
    const hide = () => { clearTimeout(wait); setShown(false); clearTimeout(cool); cool = setTimeout(() => { warm = false }, 400) }
    const over = (e: Event) => { const b = (e.target as Element).closest<HTMLElement>('button'); if (b && el.contains(b)) show(b); else hide() }
    // (focus from the keyboard only: a click focuses too, and the name would linger after it)
    const focus = (e: FocusEvent) => { const b = e.target as HTMLElement; if (b.matches(':focus-visible')) show(b) }
    el.addEventListener('pointerover', over); el.addEventListener('pointerleave', hide)
    el.addEventListener('focusin', focus); el.addEventListener('focusout', hide)
    el.addEventListener('pointerdown', hide)
    return () => {
      clearTimeout(wait); clearTimeout(cool)
      el.removeEventListener('pointerover', over); el.removeEventListener('pointerleave', hide)
      el.removeEventListener('focusin', focus); el.removeEventListener('focusout', hide)
      el.removeEventListener('pointerdown', hide)
    }
  }, [bar])
  if (!tip) return null
  return createPortal(<span className={styles.tip} data-shown={shown || undefined} aria-hidden="true" style={{ left: tip.x, bottom: tip.bottom }}>{tip.text}</span>, document.body)
}

// The hand, fetched with the toolbar (its own option is set in it): the stylesheet, then the face itself
let hand: Promise<unknown> | null = null
function handFont() {
  if (hand) return hand
  let link = document.querySelector<HTMLLinkElement>(`link[href="${HAND_FONT.css}"]`)
  const sheet = link?.sheet ? Promise.resolve() : new Promise<void>((done) => {
    if (!link) { link = document.createElement('link'); link.rel = 'stylesheet'; link.href = HAND_FONT.css; document.head.append(link) }
    link.addEventListener('load', () => done(), { once: true }); link.addEventListener('error', () => done(), { once: true })
  })
  // (both weights: the toolbar's 450 draws in the 500 face, the posters' notes in both)
  hand = sheet.then(() => Promise.all([400, 500].map((w) => document.fonts.load(`${w} 12px '${HAND_FONT.family}'`)))).catch(() => {})
  return hand
}

// (a name inside the pill, ahead of what it names)
function Group({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.group}><span className={styles.label} aria-hidden="true">{label}</span>{children}</div>
}

// A group of radios: one stop for Tab (the chosen one, or the first), and the arrow keys move along it, choosing as
// they go, the way a native radio group does
function arrows(e: React.KeyboardEvent<HTMLElement>) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
  const at = radios.indexOf(document.activeElement as HTMLButtonElement)
  if (at < 0) return
  e.preventDefault()
  const next = radios[(at + step + radios.length) % radios.length]
  next.focus()
  // (the plus opens a picker rather than choosing, so arriving on it doesn't press it)
  if (!next.hasAttribute('data-more')) next.click()
}
const stop = (checked: boolean, first: boolean, anyChecked: boolean) => (checked || (!anyChecked && first) ? 0 : -1)

// Two or three options on a pill, the chosen one under a white pill that slides between them; the labels are drawn
// twice, the second set dark and clipped to the pill, so a label turns dark exactly where the pill passes under it.
type Option<V extends string> = { value: V; label: string; icon?: ReactNode; font?: string }
function Segmented<V extends string>({ label, value, onChange, options, text = false }: { label: string; value: V; onChange: (v: V) => void; options: Option<V>[]; text?: boolean }) {
  const row = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ l: number; w: number; W: number } | null>(null)
  // (no slide on the first placement: the pill starts where it belongs)
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    const el = row.current
    const b = el?.querySelector<HTMLElement>(`[data-value="${value}"]`)
    if (!el || !b) return
    const measure = () => setBox({ l: b.offsetLeft, w: b.offsetWidth, W: el.offsetWidth })
    measure()
    const ro = new ResizeObserver(measure); ro.observe(el)
    return () => ro.disconnect()
  }, [value])
  useEffect(() => { if (box && !ready) requestAnimationFrame(() => setReady(true)) }, [box, ready])
  const face = (o: Option<V>) => <span className={styles.optionFace} style={o.font ? { fontFamily: o.font } : undefined}>{o.icon}{(text || !o.icon) && o.label}</span>
  return (
    <div ref={row} className={styles.segmented} role="radiogroup" aria-label={label} data-ready={ready || undefined} onKeyDown={arrows}>
      {box && <span className={styles.indicator} style={{ left: box.l, width: box.w }} />}
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} aria-label={o.label} tabIndex={o.value === value ? 0 : -1} data-value={o.value} data-text={text || undefined} className={styles.option} onClick={() => onChange(o.value)}>
          {face(o)}
        </button>
      ))}
      {box && <div className={styles.onLayer} aria-hidden="true" style={{ clipPath: `inset(0 ${box.W - box.l - box.w}px 0 ${box.l}px round 999px)` }}>
        {options.map((o) => <span key={o.value} className={styles.option} data-text={text || undefined}>{face(o)}</span>)}
      </div>}
    </div>
  )
}

// The poster's own colour first, a few picked ones, then any colour. A colour picked through the plus takes the
// plus's place; pointing at it shows an X, and a click there puts it away, back to the poster's own. The plus then
// opens the picker on the colour last picked.
function Swatches({ label, value, onChange, names, dark, auto, autoLabel }: { label: string; value?: string; onChange: (v?: string) => void; names: readonly string[]; dark: boolean; auto?: string; autoLabel: string }) {
  const [picking, setPicking] = useState<'open' | 'closing' | false>(false)
  const plus = useRef<HTMLButtonElement>(null)
  const custom = value && !names.includes(value)
  const last = useRef<string | undefined>(undefined)
  if (custom) last.current = colourOf(value, dark)
  // (closing fades it out before it goes; the plus gets focus back when a key closed it)
  const close = (refocus: boolean) => { setPicking((p) => (p ? 'closing' : p)); setTimeout(() => setPicking((p) => (p === 'closing' ? false : p)), 120); if (refocus) plus.current?.focus() }
  return (
    <div className={styles.swatches} role="radiogroup" aria-label={label} onKeyDown={arrows}>
      <button type="button" role="radio" aria-checked={!value} aria-label={autoLabel} tabIndex={stop(!value, true, true)} className={styles.swatch} data-auto style={auto ? ({ '--c': auto } as React.CSSProperties) : undefined} onClick={() => onChange(undefined)} />
      {names.map((n) => <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={nameOf(n)} tabIndex={stop(value === n, false, true)} className={styles.swatch} style={{ '--c': colourOf(n, dark) } as React.CSSProperties} onClick={() => onChange(n)} />)}
      <div className={styles.more}>
        <button ref={plus} type="button" aria-label={custom ? `Remove ${value}` : 'Any colour'} aria-expanded={!custom ? picking === 'open' : undefined} aria-checked={!!custom} role="radio" tabIndex={stop(!!custom, false, true)} className={styles.swatch} data-more data-custom={custom || undefined}
          style={custom ? ({ '--c': colourOf(value, dark) } as React.CSSProperties) : undefined}
          onClick={() => { if (custom && picking !== 'open') onChange(undefined); else if (picking === 'open') close(false); else setPicking('open') }}>
          <span className={styles.moreIcons}><Plus /><Cross /></span>
        </button>
        {picking && <Picker anchor={plus} closing={picking === 'closing'} value={last.current ?? colourOf('blue', dark)!} onChange={onChange} onClose={close} />}
      </div>
    </div>
  )
}

// Any colour: saturation and brightness in the square, the hue in the strip, or typed as hex. It stays open until a
// click outside it, or Escape. It opens above its plus, on the page itself: inside the toolbar, which scrolls
// sideways on a narrow screen, it would be cut off.
function Picker({ anchor, closing, value, onChange, onClose }: { anchor: React.RefObject<HTMLElement | null>; closing: boolean; value: string; onChange: (v: string) => void; onClose: (refocus: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null)
  // (in from a few px below once placed, out the same way)
  const [entered, setEntered] = useState(false)
  useEffect(() => { const id = requestAnimationFrame(() => setEntered(true)); return () => cancelAnimationFrame(id) }, [])
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect(), w = root.current?.offsetWidth ?? 194
      if (r) setAt({ left: Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)), bottom: innerHeight - r.top + 13 })
    }
    place()
    addEventListener('resize', place)
    return () => removeEventListener('resize', place)
  }, [anchor])
  const [hsv, setHsv] = useState(() => toHsv(value))
  const [hex, setHex] = useState(value.toUpperCase())
  useEffect(() => {
    // (the plus toggles it itself)
    // (the reader's own clicks only: a poster's driver presses its component with synthetic events of its own)
    const down = (e: PointerEvent) => { const t = e.target as Node; if (e.isTrusted && !root.current?.contains(t) && !anchor.current?.contains(t)) onClose(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(true) }
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [onClose, anchor])
  const apply = (next: [number, number, number]) => { setHsv(next); const h = fromHsv(next); setHex(h.toUpperCase()); onChange(h) }
  const drag = (el: HTMLElement, at: (x: number, y: number) => void) => (e: React.PointerEvent) => {
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    el.focus({ preventScroll: true })
    const move = (ev: PointerEvent | React.PointerEvent) => { const r = el.getBoundingClientRect(); at(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height)) }
    move(e)
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeAttribute('data-dragging') }
    el.setAttribute('data-dragging', '')
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  }
  // (the arrow keys: hue in the strip, brightness and saturation in the square; with Shift, ten times as far)
  const keys = (axis: 'hue' | 'square') => (e: React.KeyboardEvent) => {
    const k = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0, dy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0
    if (!dx && !dy) return
    e.preventDefault()
    if (axis === 'hue') apply([(hsv[0] + (dx || dy) * k + 360) % 360, hsv[1], hsv[2]])
    else apply([hsv[0], clamp(hsv[1] + dx * 0.01 * k), clamp(hsv[2] + dy * 0.01 * k)])
  }
  const square = useRef<HTMLDivElement>(null), strip = useRef<HTMLDivElement>(null)
  return (
    createPortal(<div ref={root} className={styles.picker} role="dialog" aria-label="Pick a colour" data-shown={(entered && !closing) || undefined} style={at ? { left: at.left, bottom: at.bottom } : { visibility: 'hidden' }}>
      <div ref={square} className={styles.square} tabIndex={0} role="slider" aria-label="Saturation and brightness" aria-valuetext={`${Math.round(hsv[1] * 100)}% saturation, ${Math.round(hsv[2] * 100)}% brightness`} style={{ backgroundColor: `hsl(${hsv[0]} 100% 50%)` }} onKeyDown={keys('square')} onPointerDown={(e) => drag(square.current!, (x, y) => apply([hsv[0], x, 1 - y]))(e)}>
        <span className={styles.knob} style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: fromHsv(hsv) }} />
      </div>
      <div ref={strip} className={styles.hue} tabIndex={0} role="slider" aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv[0])} onKeyDown={keys('hue')} onPointerDown={(e) => drag(strip.current!, (x) => apply([x * 360, hsv[1], hsv[2]]))(e)}>
        <span className={styles.knob} style={{ left: `${(hsv[0] / 360) * 100}%`, top: '50%', background: `hsl(${hsv[0]} 100% 50%)` }} />
      </div>
      {/* (typed with or without its #, three digits or six; tidied to the colour in use when it loses focus) */}
      <input className={styles.hex} value={hex} spellCheck={false} autoComplete="off" maxLength={7} aria-label="Hex colour"
        onChange={(e) => { const v = e.target.value; setHex(v); const rgb = hexToRgb(v); if (rgb) { const h = rgbToHex(rgb); setHsv(toHsv(h)); onChange(h) } }}
        onBlur={() => setHex(fromHsv(hsv).toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') onClose(true) }} />
    </div>, document.body)
  )
}

const clamp = (v: number) => Math.max(0, Math.min(1, v))
// ('blueprint' → 'Blueprint')
const nameOf = (n: string) => n.replace(/^./, (c) => c.toUpperCase())
function toHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex) ?? [0, 0.53, 1]
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, max === 0 ? 0 : d / max, max]
}
function fromHsv([h, s, v]: [number, number, number]) {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }
  return rgbToHex([f(5), f(3), f(1)])
}

const icon = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
const Sun = () => <svg {...icon}><circle cx="8" cy="8" r="2.75" /><path d="M8 1.75v1M8 13.25v1M1.75 8h1M13.25 8h1M3.6 3.6l.7.7M11.7 11.7l.7.7M3.6 12.4l.7-.7M11.7 4.3l.7-.7" /></svg>
const Moon = () => <svg {...icon}><path d="M13.25 9.5A5.5 5.5 0 0 1 6.5 2.75a5.5 5.5 0 1 0 6.75 6.75Z" /></svg>
const Sheet = ({ w, h }: { w: number; h: number }) => <svg {...icon}><rect x={8 - w / 2} y={8 - h / 2} width={w} height={h} rx="1.5" /></svg>
const Plus = () => <svg {...icon} width={12} height={12} viewBox="0 0 12 12" data-icon="plus"><path d="M6 2.5v7M2.5 6h7" /></svg>
const Cross = () => <svg {...icon} width={10} height={10} viewBox="0 0 10 10" data-icon="cross"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" /></svg>
