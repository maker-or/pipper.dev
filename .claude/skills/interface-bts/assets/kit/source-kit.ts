'use client'

import { type RefObject, useLayoutEffect } from 'react'

// What most demo sources share: one data attribute that CSS animates on (data-open, data-on, data-value…), set by
// the component's own handler, and the same handler exposed to the spec as `set`.
export type SetController<V = boolean> = { set: (value: V) => void }

export function useDataState<V>(rootRef: RefObject<HTMLElement | null>, controllerRef: RefObject<SetController<V> | null>, attr: string, toggle?: { trigger: string; next: (now: string | undefined) => V }) {
  useLayoutEffect(() => {
    const root = rootRef.current!
    const set = (value: V) => { root.dataset[attr] = String(value) }
    controllerRef.current = { set }
    const trigger = toggle ? root.querySelector<HTMLElement>(toggle.trigger) ?? root : null
    const click = () => toggle && set(toggle.next(root.dataset[attr]))
    trigger?.addEventListener('click', click)
    return () => {
      trigger?.removeEventListener('click', click)
      controllerRef.current = null
      root.getAnimations({ subtree: true }).forEach((a) => a.cancel())
    }
  }, [rootRef, controllerRef, attr, toggle])
}

// Put a component at its start with no transition (so nothing animates on the way there), then hand back.
export function startWithout(parts: (HTMLElement | SVGElement)[], toStart: () => void) {
  parts.forEach((el) => { el.style.transition = 'none' })
  toStart()
  // (a style read flushes the start for SVG parts too, which have no offsetWidth to read)
  parts.forEach((el) => void getComputedStyle(el).opacity)
  parts.forEach((el) => { el.style.transition = '' })
}

export const ms = (v: string) => parseFloat(v) * (v.trim().endsWith('ms') ? 1 : 1000)
