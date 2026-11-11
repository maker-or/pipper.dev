'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './sheet-playback.module.css'

type Timeline = { root: HTMLElement; animations: Animation[]; duration: number; read: (elapsed: number) => void }

// Replay the source's captured browser animations, with their own timing and
// easing. The reset starts another entrance; it isn't a substitute exit tween.
// A sheet opens paused on its telling moment (`start`, a fraction of the run); Play is the option.
export function useSheetPlayback(ready: boolean, reduced: boolean | undefined, start = 0) {
  const timeline = useRef<Timeline | null>(null)
  const fraction = useRef(start)
  const [enabled, setEnabled] = useState(false)
  const [speed, setSpeed] = useState(1)
  const rate = useRef(speed)
  rate.current = speed
  const playing = enabled && !reduced

  useEffect(() => {
    if (ready) timeline.current?.animations.forEach((animation) => animation.updatePlaybackRate(speed))
  }, [ready, speed])

  const glide = useRef(0)
  useEffect(() => () => cancelAnimationFrame(glide.current), [])

  const seek = (value: number) => {
    cancelAnimationFrame(glide.current)
    setEnabled(false)
    fraction.current = value
    const current = timeline.current
    if (!current) return
    const time = current.duration * value
    current.animations.forEach((animation) => { animation.pause(); animation.currentTime = time })
    current.read(time)
  }

  // Picking a moment runs the real animations there from where they are, at the chosen speed: forward when it's
  // later, in reverse when it's earlier. Time moves evenly; the animation's own easing shapes the motion, so what
  // plays is the interaction itself, not a substitute tween. Reduced motion jumps.
  const glideTo = (value: number) => {
    const current = timeline.current
    if (!current || reduced || matchMedia('(prefers-reduced-motion: reduce)').matches) return seek(value)
    cancelAnimationFrame(glide.current)
    setEnabled(false)
    fraction.current = value
    const from = Number(current.animations[0]?.currentTime ?? 0)
    const to = current.duration * value
    const span = Math.abs(to - from) / rate.current
    if (span < 16) return seek(value)
    current.animations.forEach((animation) => animation.pause())
    const start = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / span)
      const time = from + (to - from) * k
      current.animations.forEach((animation) => { animation.currentTime = time })
      current.read(time)
      if (k < 1) glide.current = requestAnimationFrame(step)
    }
    glide.current = requestAnimationFrame(step)
  }

  useEffect(() => {
    const current = timeline.current
    if (!ready || !playing || !current || !current.duration || !current.animations.length) return
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined, inView = true, disposed = false
    const sample = () => {
      const time = Math.max(0, Math.min(current.duration, Number(current.animations[0].currentTime ?? 0)))
      fraction.current = time / current.duration
      current.read(time)
      return time
    }
    const stop = () => {
      clearTimeout(timer); cancelAnimationFrame(frame)
      current.animations.forEach((animation) => animation.pause())
    }
    const available = () => !disposed && inView && !document.hidden
    const tick = () => {
      if (!available()) return
      const time = sample()
      if (time >= current.duration - 0.1) {
        current.animations.forEach((animation) => { animation.pause(); animation.currentTime = current.duration })
        sample()
        timer = setTimeout(restart, 1800)
      } else frame = requestAnimationFrame(tick)
    }
    const play = () => {
      if (!available()) return
      current.animations.forEach((animation) => { animation.updatePlaybackRate(rate.current); animation.play() })
      frame = requestAnimationFrame(tick)
    }
    const restart = () => {
      if (!available()) return
      current.animations.forEach((animation) => { animation.pause(); animation.currentTime = 0 })
      sample()
      timer = setTimeout(play, 650)
    }
    const resume = () => {
      stop()
      if (!available()) return
      if (sample() >= current.duration - 0.1) timer = setTimeout(restart, 1800)
      else play()
    }
    const visibility = () => document.hidden ? stop() : resume()
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      if (inView) resume(); else stop()
    })
    observer.observe(current.root.closest('[data-bts-subject-area]') ?? current.root)
    document.addEventListener('visibilitychange', visibility)
    resume()
    return () => { disposed = true; stop(); observer.disconnect(); document.removeEventListener('visibilitychange', visibility) }
  }, [ready, playing])

  const toggle = () => {
    cancelAnimationFrame(glide.current)
    const current = timeline.current
    if (playing && current) {
      current.animations.forEach((animation) => animation.pause())
      const time = Number(current.animations[0]?.currentTime ?? 0)
      fraction.current = time / current.duration
      current.read(time)
    }
    setEnabled((value) => !value)
  }
  return { timeline, fraction, playing, seek, glideTo, toggle, speed, setSpeed }
}

export function PlaybackControls({ playing, onToggle, speed, onSpeedChange }: { playing: boolean; onToggle: () => void; speed: number; onSpeedChange: (speed: number) => void }) {
  return <div className={styles.controls}><span>Interaction</span><div className={styles.actions}><div className={styles.speeds} role="group" aria-label="Playback speed">{[0.1, 0.5, 1].map((value) => <button key={value} type="button" aria-label={`${value}x speed`} aria-pressed={speed === value} onClick={() => onSpeedChange(value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSpeedChange(value) } }}>{value}×</button>)}</div><button type="button" aria-label={playing ? 'Pause interaction' : 'Play interaction'} onClick={onToggle} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}>
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>{playing ? <path d="M5.5 3.5v9M10.5 3.5v9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : <path d="M5.5 3.5v9l7-4.5z" fill="currentColor" strokeLinejoin="round" />}</svg>{playing ? 'Pause' : 'Play'}
  </button></div></div>
}
