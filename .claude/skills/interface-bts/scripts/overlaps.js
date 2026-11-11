// bts-overlaps.js — measure a BTS overlay for crowding instead of judging it by eye.
//
// Paste into the page (console, or a browser tool's evaluate), then call:
//   btsPosterOverlaps()                 // every kit poster on the page: the one to run
//   btsOverlaps({ overlay: '#debug', subject: '.card' })   // any other overlay
//
// Each returns an array of plain-language problems; an empty array means clean. It checks:
//   - overlay text that sits on the subject's box ("on the component")
//   - overlay text over the subject's own text ("over the component")
//   - overlay text over other overlay text
//   - overlay text that runs off the window, or off the poster's sheet
//   - overlay text over the overlay's own straight lines (a reference line, a guide)
//   - leader lines that cut through any text, or that cross each other
//   - concept visuals ([data-bts-concept]: an exploded stack, a magnified detail, a curve drawn away from the
//     component) closer than `conceptGap` (55px) to the subject, with words over them, off screen, or with a
//     leader running through them on its way somewhere else
// and, for a kit poster, that its foot (notes, figure 2, specification) ends above the title block and inside the
// sheet: landscape is where a long note runs over.
// Only visible text counts: text clipped by an overflow-hidden ancestor is clipped before measuring, and
// hidden or fully transparent text is skipped.
//
// Run it in every state (rest, mid-motion, each edge case) at more than one window size (for example
// 1280×800 and 1024×768), in portrait and landscape. Overlays re-render every frame, so take a screenshot or wait
// a frame first if the page's frames only run when something drives them.
;(function () {
  function intersect(a, b) {
    const l = Math.max(a.left, b.left)
    const t = Math.max(a.top, b.top)
    return new DOMRect(l, t, Math.max(0, Math.min(a.right, b.right) - l), Math.max(0, Math.min(a.bottom, b.bottom) - t))
  }

  function area(a, b) {
    return (
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    )
  }

  // (skip: elements whose text isn't counted, the overlays when reading the page's own words)
  function textBoxes(root, skip = []) {
    const out = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent && n.textContent.trim()
      if (!text || skip.some((s) => s.contains(n))) continue
      const el = n.parentElement
      // (and not words a note is fading out of, or a note folding away)
      if (!el || el.closest('style, script, [data-bts-ghost], [data-bts-leaving]')) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
      let clip = null
      for (let a = el; a && a !== root.parentElement; a = a.parentElement) {
        const o = getComputedStyle(a)
        if (/hidden|clip|auto|scroll/.test(o.overflow + o.overflowX + o.overflowY)) {
          const ar = a.getBoundingClientRect()
          clip = clip ? intersect(clip, ar) : ar
        }
      }
      range.selectNodeContents(n)
      for (const raw of Array.from(range.getClientRects())) {
        const r = clip ? intersect(raw, clip) : raw
        if (r.width > 0 && r.height > 0) out.push({ text, r, el })
      }
    }
    return out
  }

  function segmentHitsRect(x1, y1, x2, y2, r) {
    if (r.r <= r.l || r.b <= r.t) return false
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2))
    for (let i = 0; i <= n; i++) {
      const x = x1 + ((x2 - x1) * i) / n
      const y = y1 + ((y2 - y1) * i) / n
      if (x > r.l && x < r.r && y > r.t && y < r.b) return true
    }
    return false
  }

  function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0
  }

  // a leader (a line or a polyline) as points on screen, through the SVG's own transform and any scale round it
  function leaderPoints(el) {
    const local = el.tagName.toLowerCase() === 'line'
      ? [[+el.getAttribute('x1'), +el.getAttribute('y1')], [+el.getAttribute('x2'), +el.getAttribute('y2')]]
      : (el.getAttribute('points') || '').trim().split(/\s+/).map((p) => p.split(',').map(Number))
    const m = el.getScreenCTM()
    return m ? local.map(([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(m); return [p.x, p.y] }) : local
  }

  const all = (v) => (v == null ? [] : typeof v === 'string' ? Array.from(document.querySelectorAll(v)) : [].concat(v).filter(Boolean))

  // the checks, on elements: overlays (one or more), the subject (its box and its words), the sheet if there is one
  function check({ overlays, subject, words, sheet, leaders, concept, conceptGap }) {
    const box = subject && subject.getBoundingClientRect()
    const ours = overlays.flatMap((ov) => textBoxes(ov))
    const theirs = words ? textBoxes(words, overlays) : []
    const edge = sheet && sheet.getBoundingClientRect()
    const found = []

    ours.forEach((a, i) => {
      if (box && area(a.r, box) > 4) found.push(`on the component: "${a.text}"`)
      if (a.r.left < 0 || a.r.top < 0 || a.r.right > innerWidth || a.r.bottom > innerHeight) found.push(`off screen: "${a.text}"`)
      if (edge && (a.r.left < edge.left - 1 || a.r.top < edge.top - 1 || a.r.right > edge.right + 1 || a.r.bottom > edge.bottom + 1)) found.push(`off the poster: "${a.text}"`)
      for (const b of theirs) if (area(a.r, b.r) > 4) found.push(`over the component: "${a.text}" × "${b.text}"`)
      for (const b of ours.slice(i + 1)) if (b.text !== a.text && area(a.r, b.r) > 4) found.push(`overlay × overlay: "${a.text}" × "${b.text}"`)
    })

    // (each leader with its own group: a callout's line runs into its own number, which isn't a crossing)
    const leaderEls = overlays.flatMap((ov) => Array.from(ov.querySelectorAll(leaders)))
    const lines = leaderEls.map(leaderPoints)
    // concept visuals: measured by everything drawn inside them, since a tilt or a scale throws parts past their box,
    // each part cut to any ancestor inside the visual that hides its overflow (a clipped copy counts as its slice)
    for (const el of overlays.flatMap((ov) => Array.from(ov.querySelectorAll(concept)))) {
      const rs = [el, ...Array.from(el.querySelectorAll('*'))]
        .map((e) => {
          let r = e.getBoundingClientRect()
          for (let a = e === el ? null : e.parentElement; a; a = a === el ? null : a.parentElement) {
            const cs = getComputedStyle(a)
            if (/hidden|clip|auto|scroll/.test(cs.overflowX + cs.overflowY)) r = intersect(r, a.getBoundingClientRect())
          }
          return r
        })
        .filter((r) => r.width > 0 && r.height > 0)
      if (!rs.length) continue
      const d = { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) }
      if (box) {
        const gap = Math.hypot(Math.max(0, d.left - box.right, box.left - d.right), Math.max(0, d.top - box.bottom, box.top - d.bottom))
        if (gap < conceptGap - 1) found.push(`concept visual ${Math.round(gap)}px from the component (keep ${conceptGap})`)
      }
      if (d.left < 0 || d.top < 0 || d.right > innerWidth || d.bottom > innerHeight) found.push('concept visual off screen')
      const own = textBoxes(el)
      for (const t of ours.concat(theirs))
        if (!own.some((w) => w.r.x === t.r.x && w.r.y === t.r.y) && area(t.r, d) > 4) found.push(`words over the concept visual: "${t.text}"`)
      // (a leader that ends in it is pointing at it)
      for (const pts of lines) {
        const end = pts[pts.length - 1]
        if (end[0] > d.left - 8 && end[0] < d.right + 8 && end[1] > d.top - 8 && end[1] < d.bottom + 8) continue
        if (pts.slice(1).some((q, i) => segmentHitsRect(pts[i][0], pts[i][1], q[0], q[1], { l: d.left, t: d.top, r: d.right, b: d.bottom }))) found.push('leader crosses the concept visual')
      }
    }

    const texts = theirs.concat(ours)
    for (const [n, pts] of lines.entries()) {
      const own = leaderEls[n].parentElement
      for (let i = 0; i < pts.length - 1; i++) {
        for (const t of texts) {
          if (own && own !== leaderEls[n].ownerSVGElement && own.contains(t.el)) continue
          const r = { l: t.r.left + 2, t: t.r.top + 2, r: t.r.right - 2, b: t.r.bottom - 2 }
          if (segmentHitsRect(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r)) {
            found.push(`leader crosses: "${t.text}"`)
            break
          }
        }
      }
    }
    // words over the overlay's own straight lines (a reference line, a guide, an axis), not only over leaders and
    // other words; a line beside its own words (a dimension and its size) is in their group and isn't counted
    for (const el of overlays.flatMap((ov) => Array.from(ov.querySelectorAll('line:not([data-bts-leader])')))) {
      const [a, b] = leaderPoints(el)
      if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue
      const group = el.parentElement && el.parentElement !== el.ownerSVGElement ? el.parentElement : null
      for (const t of ours) {
        if (group && group.contains(t.el)) continue
        if (segmentHitsRect(a[0], a[1], b[0], b[1], { l: t.r.left + 2, t: t.r.top + 2, r: t.r.right - 2, b: t.r.bottom - 2 })) found.push(`words over a line: "${t.text}"`)
      }
    }
    const segs = lines.flatMap((pts, k) => pts.slice(1).map((p, i) => ({ k, a: pts[i], b: p })))
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++)
        if (segs[i].k !== segs[j].k && segmentsCross(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) found.push('two leaders cross')

    return Array.from(new Set(found))
  }

  const DEFAULTS = { leaders: '[data-bts-leader], polyline[data-bts-leader]', concept: '[data-bts-concept]', conceptGap: 55 }

  // Any overlay. `overlay`, `subject` and `page` are selectors or elements; every overlay matched is checked.
  window.btsOverlaps = function btsOverlaps(options) {
    const o = Object.assign({ overlay: '[data-bts-overlay]', page: 'main', subject: null, sheet: null }, DEFAULTS, options || {})
    const overlays = all(o.overlay)
    const page = all(o.page)[0]
    if (!overlays.length || !page) return ['overlay is off']
    // (the subject: the page's first child that isn't an overlay or a style tag)
    const subject = o.subject ? all(o.subject)[0] : Array.from(page.children).find((c) => !overlays.includes(c) && c.tagName !== 'STYLE')
    return check({ ...o, overlays, subject, words: page, sheet: all(o.sheet)[0] })
  }

  // Every poster built with the kit, each on its own: its drawings (figure 1's overlay, the timeline, figure 2) over
  // its live component, its words kept on its sheet, and its foot clear of the title block. Problems are prefixed
  // with the poster's name.
  window.btsPosterOverlaps = function btsPosterOverlaps(options) {
    const o = Object.assign({}, DEFAULTS, options || {})
    const found = [], away = []
    for (const sheet of document.querySelectorAll('[data-poster]')) {
      const name = (sheet.querySelector('h1') && sheet.querySelector('h1').textContent) || 'poster'
      // (only a poster wholly in the window: on the page of all posters the rest are scrolled away, and every word on
      // them would read as off screen. Scroll each into view in turn)
      const at = sheet.getBoundingClientRect()
      if (at.left < -1 || at.top < -1 || at.right > innerWidth + 1 || at.bottom > innerHeight + 1) { away.push(name); continue }
      const drawing = sheet.querySelector('[data-drawing]')
      // (the live component: the element marked data-subject-root, or the root the poster's driver holds, the first
      // element inside the drawing's one child that isn't a drawing of the poster's own; that child itself spans the
      // drawing's width)
      const holder = drawing && Array.from(drawing.children).find((c) => c.tagName.toLowerCase() !== 'svg')
      const subject = (drawing && drawing.querySelector('[data-subject-root]')) || (holder && (holder.firstElementChild || holder))
      // (the poster's own drawings: every SVG on the sheet but the component's icons and the moments' copies)
      const overlays = Array.from(sheet.querySelectorAll('svg')).filter((s) => !(subject && subject.contains(s)) && !s.closest('[inert]') && !(s.parentElement && s.parentElement.closest('svg')))
      for (const p of check({ ...o, overlays, subject, words: subject, sheet })) found.push(`${name}: ${p}`)
      // (figure 1 squeezed: in portrait a long foot takes the figure's room, and the drawing and its moments spill
      // out of it, up over the title, before the foot ever reaches the title block)
      const figure = drawing && drawing.parentElement
      if (figure) {
        const room = figure.getBoundingClientRect(), k = sheet.getBoundingClientRect().width / sheet.offsetWidth
        const parts = Array.from(figure.children).map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0)
        const over = Math.max(room.top - Math.min(...parts.map((r) => r.top)), Math.max(...parts.map((r) => r.bottom)) - room.bottom)
        if (over > 1) found.push(`${name}: figure 1 doesn't fit its room by ${Math.round(over / k)}px (shorten the notes, or lower the drawing scale)`)
      }
      const foot = sheet.querySelector('[data-foot]'), block = sheet.querySelector('[data-title-block]')
      if (foot && block) {
        const parts = Array.from(foot.querySelectorAll('*')).map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0)
        const bottom = Math.max(...parts.map((r) => r.bottom)), edge = sheet.getBoundingClientRect(), top = block.getBoundingClientRect().top
        // (in the poster's own px, whatever it's scaled to on screen)
        const k = edge.width / sheet.offsetWidth
        if (bottom > top + 1) found.push(`${name}: the foot runs ${Math.round((bottom - top) / k)}px into the title block`)
        if (bottom > edge.bottom + 1) found.push(`${name}: the foot runs off the poster`)
      }
    }
    if (away.length) console.info(`btsPosterOverlaps: not in view, so not checked: ${away.join(', ')}`)
    return found
  }
})()
