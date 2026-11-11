'use client'

import { useEffect, useRef } from 'react'
import styles from './sheet-states.module.css'

export type StateSnapshot = { html: string; width: number; height: number; time: number; left: number; top: number }

// Static DOM copies preserve the values read from the real paused animation.
// No clone runs event handlers, timers or a second animation.
function snapshot(root: HTMLElement, time: number): StateSnapshot {
  const properties = ['transform', 'transform-origin', 'translate', 'scale', 'opacity', 'filter', 'clip-path', 'grid-template-rows', 'width', 'height', 'position', 'left', 'top', 'right', 'bottom', 'display', 'box-sizing', 'color', 'zoom']
  const copy = (source: Element): Element => {
    const safeTag = ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(source.tagName) ? 'span' : null
    const clone = safeTag ? document.createElement(safeTag) : source.cloneNode(false) as Element
    if (safeTag) for (const attribute of source.attributes) clone.setAttribute(attribute.name, attribute.value)
    clone.removeAttribute('id'); clone.removeAttribute('aria-describedby'); clone.removeAttribute('aria-controls'); clone.removeAttribute('tabindex')
    for (const attribute of [...clone.attributes]) if (attribute.name.startsWith('data-source') || ['data-toolbar-tips', 'data-tip-bubble'].includes(attribute.name)) clone.removeAttribute(attribute.name)
    const computed = getComputedStyle(source), style = (clone as HTMLElement | SVGElement).style
    if (style) {
      for (const property of properties) style.setProperty(property, computed.getPropertyValue(property), 'important')
      style.setProperty('animation', 'none', 'important'); style.setProperty('transition', 'none', 'important'); style.pointerEvents = 'none'
    }
    for (const child of source.childNodes) {
      if (child instanceof Element) { if (!['STYLE', 'SCRIPT'].includes(child.tagName)) clone.append(copy(child)) }
      else clone.append(child.cloneNode(true))
    }
    return clone
  }
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;z-index:-1;'
  const clone = copy(root) as HTMLElement
  clone.inert = true; clone.style.visibility = 'visible'; clone.setAttribute('aria-hidden', 'true')
  host.append(clone); (root.closest('main') ?? document.body).append(host)
  const origin = host.getBoundingClientRect()
  const bounds = [clone, ...clone.querySelectorAll<HTMLElement>('*')].filter((element) => element instanceof HTMLElement && getComputedStyle(element).visibility !== 'hidden').map((element) => element.getBoundingClientRect()).filter((box) => box.width && box.height)
  const left = Math.min(...bounds.map((box) => box.left)) - origin.left, top = Math.min(...bounds.map((box) => box.top)) - origin.top
  const width = Math.max(...bounds.map((box) => box.right)) - origin.left - left, height = Math.max(...bounds.map((box) => box.bottom)) - origin.top - top
  const html = clone.outerHTML
  host.remove()
  return { html, width, height, time, left, top }
}

export function captureStates(root: HTMLElement, animations: Animation[], duration: number, fractions: readonly number[]) {
  return captureEach(root, fractions.length, (i) => {
    const time = duration * fractions[i]
    animations.forEach((animation) => { animation.pause(); animation.currentTime = time })
    return time
  })
}

// One snapshot per moment, each after `apply(i)` has put the component there (it returns the moment's value: a
// time, or a scroll position), all framed by one camera.
export function captureEach(root: HTMLElement, count: number, apply: (i: number) => number) {
  const images = Array.from({ length: count }, (_, i) => snapshot(root, apply(i)))
  // Use one camera for the whole row, so expansion doesn't look like shrinkage
  // and translation isn't cancelled by fitting each frame independently.
  const left = Math.min(...images.map((image) => image.left)), top = Math.min(...images.map((image) => image.top))
  const width = Math.max(...images.map((image) => image.left + image.width)) - left
  const height = Math.max(...images.map((image) => image.top + image.height)) - top
  return images.map((image) => {
    const carrier = document.createElement('div')
    carrier.style.cssText = `position:absolute;left:${-left}px;top:${-top}px;`
    carrier.innerHTML = image.html
    // (left and top: where the component's own origin sits in the frame, for a crop)
    return { ...image, left, top, width, height, html: carrier.outerHTML }
  })
}

function Preview({ snapshot: image }: { snapshot: StateSnapshot }) {
  const host = useRef<HTMLDivElement>(null)
  const model = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const measure = () => {
      const root = host.current, content = model.current
      if (!root || !content) return
      const scale = Math.min(1, (root.clientWidth - 16) / image.width, (root.clientHeight - 16) / image.height)
      content.style.transform = `translate(-50%, -50%) scale(${scale})`
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host.current!); measure()
    return () => observer.disconnect()
  }, [image])
  return <div ref={host} className={styles.preview} aria-hidden="true"><div ref={model} className={styles.model} style={{ width: image.width, height: image.height }} dangerouslySetInnerHTML={{ __html: image.html }} /></div>
}

// (compact: small frames for a spec sheet's foot, no rule above)
// (bare: no caption under each frame, when a drawing under the row says when each was taken; the name stays in its label)
export function StateRow({ images, labels, selected, onSelect, compact = false, bare = false }: { images: StateSnapshot[]; labels: readonly string[]; selected: number; onSelect: (index: number) => void; compact?: boolean; bare?: boolean }) {
  if (!images.length) return null
  return <div className={`${styles.states} ${compact ? styles.compact : ''} ${bare ? styles.bare : ''}`} role="group" aria-label="Captured states">{images.map((image, index) => <button key={index} className={styles.state} type="button" aria-pressed={selected === index} aria-label={`${labels[index]}, ${Number(image.time.toFixed(1))} milliseconds`} onClick={() => onSelect(index)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(index) } }}><Preview snapshot={image} /><span className={styles.caption}>{labels[index]}<span>{Number(image.time.toFixed(1))}ms</span></span></button>)}</div>
}
