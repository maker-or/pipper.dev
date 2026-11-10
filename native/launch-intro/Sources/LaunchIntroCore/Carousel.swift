import CoreGraphics
import Foundation

/// Version 2's line: "Run" sits still in a light weight while the agents'
/// names roll up beside it in a column, the current one bright and its
/// neighbours faint. It slows as it goes and lands on "any agent". Then the
/// faint names fade and "Run any agent" shrinks and glides to the heading of
/// the window the user is about to land in, which grows out from it
/// (WindowDrawing.swift).
public struct Carousel: Sendable, Equatable {
  public var lead = "Run"
  public var words = ["Claude", "Codex", "Cursor", "Gemini", "Copilot", "Grok"]
  public var last = "any agent"
  /// "Run" fades in from this time, over `appearDuration`. Version 2 sets
  /// it to just after the last ripple has crossed the display.
  public var appear: Double = 1.2
  public var appearDuration: Double = 0.4
  /// The first name rolls in here; each next one `step` later, plus
  /// `slowdown` more each time, so the column slows down.
  public var firstStep: Double = 1.6
  public var step: Double = 0.28
  public var slowdown: Double = 0.07
  /// Seconds each roll takes.
  public var slide: Double = 0.22
  /// Seconds "any agent" is held before it heads for the window.
  public var hold: Double = 0.65
  /// Seconds for the phrase to glide to the window's heading.
  public var landing: Double = 1.2
  /// Font weight traits, −1 to 1.
  public var leadWeight: Double = -0.4
  public var wordWeight: Double = 0.4
  /// Line spacing and the gap after "Run", as multiples of the font size.
  public var spacing: Double = 1.2
  public var gap: Double = 0.3
  /// How bright the neighbouring names are, relative to the current one.
  public var neighbours: Double = 0.35
  /// How bright "Run" and the names are; the phrase dims to the heading's
  /// muted colour as it lands.
  public var leadOpacity: Double = 0.75
  public var headingOpacity: Double = 0.6

  public init() {}

  /// Every word the column rolls through, ending on `last`.
  public var all: [String] { words + [last] }

  /// When word `i` of `all` starts to roll into place.
  public func stepTime(_ i: Int) -> Double {
    firstStep + Double(i) * step + slowdown * Double(i * (i - 1)) / 2
  }

  /// "any agent" is in place.
  public var landed: Double { stepTime(all.count - 1) + slide }
  /// It heads for the window.
  public var handoff: Double { landed + hold }

  /// Which word is in place, fractionally: −1 before the first rolls in.
  public func position(time t: Double) -> Double {
    guard t >= firstStep else { return -1 }
    let index = (0 ..< all.count).last { stepTime($0) <= t } ?? 0
    return Double(index) - 1 + smootherstep(0, slide, t - stepTime(index))
  }
}

/// Where one word of the carousel is drawn: index 0 is "Run", then the
/// words of `Carousel.all` from 1.
public struct WordPlacement: Sendable, Equatable {
  public var index: Int
  /// Left edge and vertical middle, device pixels, y down.
  public var origin: SIMD2<Double>
  /// Relative to the full-size word.
  public var scale: Double
  public var opacity: Double
  /// How blurred it is, in mip levels of its full-size drawing.
  public var blur: Double = 0
}

/// The carousel at `time`. `widths` are each word's full-size width in
/// device pixels, "Run" first; `heading` is where the phrase lands (the
/// window's heading, y down), or nil to leave it in place.
public func carouselPlacements(
  time t: Double, config c: IntroConfig, geometry g: IntroGeometry, widths: [Double], heading: CGRect?
) -> [WordPlacement] {
  guard let carousel = c.carousel, widths.count == carousel.all.count + 1 else { return [] }
  let size = c.fontSize * g.q
  let gap = carousel.gap * size
  let widest = widths.dropFirst().max() ?? 0
  let left = (g.width - (widths[0] + gap + widest)) / 2
  let middle = g.height / 2
  let p = carousel.position(time: t)
  let current = Int(p.rounded())
  let lastIndex = carousel.all.count - 1

  // The hand-off: the phrase glides to the heading, the rest fade.
  let land = heading == nil ? 0 : smootherstep(carousel.handoff, carousel.handoff + carousel.landing, t)
  let others = 1 - smootherstep(carousel.handoff, carousel.handoff + 0.4, t)
  var target = SIMD2(left, middle)
  var targetScale = 1.0
  if let heading {
    // The heading's box is its line; its font is about 1/1.4 of that.
    targetScale = Double(heading.height) / 1.4 / size
    target = [Double(heading.minX), Double(heading.midY)]
  }
  let scale = 1 + (targetScale - 1) * land
  let phrase = SIMD2(left, middle) + (target - SIMD2(left, middle)) * land

  var placements: [WordPlacement] = []
  let leadIn = smootherstep(carousel.appear, carousel.appear + carousel.appearDuration, t)
  let leadOpacity = carousel.leadOpacity + (carousel.headingOpacity * 0.8 - carousel.leadOpacity) * land
  if leadIn > 0 {
    placements.append(WordPlacement(index: 0, origin: phrase, scale: scale, opacity: leadIn * leadOpacity))
  }
  for (i, _) in carousel.all.enumerated() {
    let d = Double(i) - p
    guard abs(d) <= 2.2 else { continue }
    let base = max(0, 1 - abs(d) * (d < 0 ? 0.75 : 0.55))
    if i == lastIndex, current == lastIndex {
      let opacity = 1 + (carousel.headingOpacity - 1) * land
      let origin = phrase + SIMD2((widths[0] + gap) * scale, d * carousel.spacing * size)
      placements.append(WordPlacement(index: i + 1, origin: origin, scale: scale, opacity: base * opacity))
      continue
    }
    // Nothing of the column shows before "Run" does.
    let opacity = (i == current ? base : base * carousel.neighbours) * others * leadIn
    guard opacity > 0 else { continue }
    let origin = SIMD2(left + widths[0] + gap, middle + d * carousel.spacing * size)
    placements.append(WordPlacement(index: i + 1, origin: origin, scale: 1, opacity: opacity))
  }
  return placements
}

/// Version 2's line: "One interface to control your agents", printed at the
/// middle by a laser once the ripples have crossed the display. A scan line
/// sweeps down over it; above the line it is already printed. It stays at
/// the middle until the window is printed over it (WindowDrawing.swift).
/// (Version 2 uses this or a `Carousel`, not both.)
public struct Phrase: Sendable, Equatable {
  public var text = "One interface to control your agents"
  /// Font weight trait, −1 to 1.
  public var weight: Double = 0
  /// The laser starts printing it here, and takes `print` seconds, in
  /// `bands` bands.
  public var appear: Double = 3.5
  public var print: Double = 1.2
  public var bands = 3
  /// Seconds it is held, printed, before the window is printed.
  public var hold: Double = 1.2

  public init() {}

  public var printed: Double { appear + print }
  /// The window starts printing.
  public var handoff: Double { printed + hold }
}

/// A printer at one moment, device pixels, y down. It prints in bands: the
/// paper feeds one band down with a quick jolt that overshoots a little and
/// settles, then stops dead while the head travels across the band, speeding
/// up and slowing at each end, printing behind itself. Passes alternate
/// direction, like a carriage.
public struct ScanLine: Sendable, Equatable {
  /// Where the scan line is: the bottom edge of the band being printed.
  public var y: Double
  /// The top of that band: everything above it is printed.
  public var top: Double
  public var left: Double
  public var right: Double
  /// Where the head is; the band is printed behind it.
  public var head: Double
  /// The head is travelling left to right.
  public var fromLeft: Bool
  public var opacity: Double

  /// Whether the point is printed yet.
  public func isPrinted(_ p: SIMD2<Double>) -> Bool {
    p.y < top || (p.y < y && (fromLeft ? p.x < head : p.x > head))
  }

  /// Nothing printed yet.
  public static let blank = ScanLine(y: -.infinity, top: -.infinity, left: 0, right: 0, head: 0, fromLeft: true, opacity: 0)
  /// Everything printed.
  public static let done = ScanLine(y: .infinity, top: .infinity, left: 0, right: 0, head: 0, fromLeft: true, opacity: 0)
}

/// Share of each band's time spent feeding the paper; the rest is the pass.
let feedShare = 0.2

/// A printer working down `area` in `bands` bands between `start` and `end`:
/// `blank` before, `done` after (its line fading out just after `end`).
public func scanLine(sweeping area: CGRect, bands: Int, from start: Double, to end: Double, time t: Double) -> ScanLine {
  guard t > start else { return .blank }
  let left = Double(area.minX)
  let right = Double(area.maxX)
  let bandHeight = Double(area.height) / Double(max(1, bands))
  if t >= end {
    // Done: everything printed, the line resting at the bottom as it fades.
    let fromLeft = (bands - 1) % 2 == 0
    return ScanLine(
      y: Double(area.maxY), top: .infinity, left: left, right: right,
      head: fromLeft ? right : left, fromLeft: fromLeft, opacity: 1 - smootherstep(end, end + 0.25, t)
    )
  }
  let stepTime = (end - start) / Double(max(1, bands))
  let step = min(bands - 1, Int((t - start) / stepTime))
  let u = (t - start) / stepTime - Double(step)
  let top = Double(area.minY) + bandHeight * Double(step)
  let bottom = top + bandHeight
  let fromLeft = step % 2 == 0
  if u < feedShare {
    // The feed: a quick jolt down one band that overshoots and settles.
    let f = u / feedShare
    let jolt = 1 - exp(-7 * f) * (cos(11 * f) + 0.64 * sin(11 * f))
    return ScanLine(
      y: top + bandHeight * jolt, top: top, left: left, right: right,
      head: fromLeft ? left : right, fromLeft: fromLeft, opacity: 1
    )
  }
  // The pass: the paper is still; the head speeds up and slows to each end.
  let pass = smootherstep(0.04, 0.96, (u - feedShare) / (1 - feedShare))
  let head = fromLeft ? left + (right - left) * pass : right - (right - left) * pass
  return ScanLine(y: bottom, top: top, left: left, right: right, head: head, fromLeft: fromLeft, opacity: 1)
}

/// Where the phrase is printed: its box at the middle of the display, full
/// size, device pixels, y down. `width` is its full-size width, `height` its
/// full-size drawing's height.
public func phraseBox(config c: IntroConfig, geometry g: IntroGeometry, width: Double, height: Double) -> CGRect {
  CGRect(x: (g.width - width) / 2, y: (g.height - height) / 2, width: width, height: height)
}

/// The printer printing the phrase, over a box a little wider and taller
/// than it.
public func phraseScan(
  time t: Double, config c: IntroConfig, geometry g: IntroGeometry, width: Double, height: Double
) -> ScanLine? {
  guard let phrase = c.phrase else { return nil }
  let box = phraseBox(config: c, geometry: g, width: width, height: height)
  let area = box.insetBy(dx: -height * 0.6, dy: -height * 0.15)
  return scanLine(sweeping: area, bands: phrase.bands, from: phrase.appear, to: phrase.printed, time: t)
}
