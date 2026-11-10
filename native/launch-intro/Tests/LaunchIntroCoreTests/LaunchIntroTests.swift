import CoreGraphics
import Foundation
@testable import LaunchIntroCore
import Metal
import Testing

private let config = IntroConfig()
private let reference = IntroGeometry(width: 1440, height: 900, config: config)

private func samplePoints(_ g: IntroGeometry, steps: Int = 12) -> [SIMD2<Double>] {
  (0 ... steps).flatMap { i in
    (0 ... steps).map { j in SIMD2(g.width * Double(i) / Double(steps), g.height * Double(j) / Double(steps)) }
  }
}

@Test func rippleSpeedClearsTheFarCornerInTravelTime() {
  #expect(abs(reference.speed - 546.7) < 0.5)
}

@Test func nothingIsDrawnBeforeTheFirstRippleArrives() {
  for p in samplePoints(reference) {
    let s = rippleSample(at: p, time: 0, geometry: reference, config: config)
    #expect(s.fill == 0)
    #expect(abs(s.height) < 1e-6)
  }
}

@Test func darknessOnlyEverIncreases() {
  for p in samplePoints(reference, steps: 6) {
    var previous = 0.0
    for step in 0 ... 120 {
      let value = darkness(at: p, time: config.end * Double(step) / 120, geometry: reference, config: config)
      #expect(value >= previous - 1e-12)
      previous = value
    }
  }
}

@Test func theWholeDisplayIsDarkOnceTheLastRippleHasCrossed() {
  let t = config.darknessComplete
  #expect(abs(t - (0.6 + config.travel)) < 1e-9)
  for p in samplePoints(reference) {
    #expect(rippleSample(at: p, time: t, geometry: reference, config: config).fill > 0.999)
  }
  #expect(abs(darkness(at: [720, 0], time: t, geometry: reference, config: config) - 0.94) < 1e-6)
  #expect(abs(darkness(at: [720, 900], time: t, geometry: reference, config: config) - 0.50) < 1e-6)
}

@Test func theRipplesLeaveBackToBack() {
  let gaps = zip(config.rippleStarts.dropFirst(), config.rippleStarts).map { $0 - $1 }
  #expect(gaps.count == 2)
  // Each one leaves before the one ahead has finished darkening the stone's edge.
  let edgeDarkens = config.soft / reference.speed
  #expect(gaps.allSatisfy { $0 > 0 && $0 <= edgeDarkens * 1.1 })
}

@Test func eachRippleBringsAThirdOfTheDarkness() {
  // The bottom centre is reached first; sample it once a ripple's soft edge
  // has passed and before the next one arrives.
  let p = SIMD2<Double>(720, 0)
  let d = simd_distance_d(p, reference.stone)
  let fill = { (t: Double) in rippleSample(at: p, time: t, geometry: reference, config: config).fill }
  for (k, start) in config.rippleStarts.enumerated() {
    let t = start + (d + config.soft) / reference.speed + 1e-4
    if k + 1 < config.rippleStarts.count {
      #expect(t < config.rippleStarts[k + 1] + d / reference.speed)
    }
    #expect(abs(fill(t) - Double(k + 1) / 3) < 1e-6)
  }
}

@Test func textSharpensFromABlurAsItFadesIn() {
  let q = 2.0
  #expect(textFrame(time: config.textFadeStart - 0.1, q: q, config: config) == TextFrame(opacity: 0, blur: 28))
  #expect(textFrame(time: config.textFadeEnd, q: q, config: config) == TextFrame(opacity: 1, blur: 0))
  let middle = textFrame(time: (config.textFadeStart + config.textFadeEnd) / 2, q: q, config: config)
  #expect(abs(middle.opacity - 0.5) < 1e-9)
  #expect(abs(middle.blur - 14) < 1e-9)
}

@Test func aPassingFrontShovesTheStageAwayFromTheStoneAndItSpringsBack() {
  // One ripple on its own, so its push isn't mixed with the next one's.
  var single = config
  single.rippleStarts = [0]
  single.rippleStrengths = [1]
  let p = SIMD2<Double>(720, 450)
  let outward = (p - reference.stone) / simd_distance_d(p, reference.stone)
  let arrival = simd_distance_d(p, reference.stone) / reference.speed
  let along = { (t: Double) in
    let push = pushOffset(at: p, time: t, geometry: reference, config: single)
    return push.x * outward.x + push.y * outward.y
  }
  #expect(along(arrival - 0.01) == 0)

  let window = (0 ... 160).map { arrival + config.pushPeriod * Double($0) / 160 }
  let pushes = window.map(along)
  // It leaves the screen as it was, then rises to one full push outward…
  #expect(abs(pushes.max()! - config.push) < 0.05)
  // …and overshoots back towards the stone before settling.
  #expect(pushes.min()! < -config.push * 0.05)
  #expect(pushes.min()! > -config.push * 0.6)
}

@Test func everythingIsBackInPlaceBeforeTheLastFrameIsHeld() {
  // The held frame is what fades away to reveal Pipper; it must be at rest.
  let retina = IntroGeometry(width: 2880, height: 1800, config: config)
  for p in samplePoints(retina) {
    let push = pushOffset(at: p, time: config.end, geometry: retina, config: config)
    #expect((push.x * push.x + push.y * push.y).squareRoot() < 0.2)
  }
}

@Test func theFirstFrontWashesTheScreenOverToTheStage() {
  let p = SIMD2<Double>(720, 450)
  let arrival = simd_distance_d(p, reference.stone) / reference.speed
  let cover = { (t: Double) in stageCover(at: p, time: t, geometry: reference, config: config) }
  #expect(cover(0) == 0)
  #expect(cover(arrival) == 0)
  #expect(cover(arrival + config.soft * config.stageWash / reference.speed) == 1)
  for p in samplePoints(reference) {
    #expect(stageCover(at: p, time: config.darknessComplete, geometry: reference, config: config) == 1)
  }
}

// The GPU frames below are what the overlay hands the window server.

/// A backdrop that is white above the middle of the display and black below.
private func horizonBackdrop(_ renderer: IntroRenderer) throws -> MTLTexture {
  let width = Int(renderer.geometry.width)
  let height = Int(renderer.geometry.height)
  let context = try #require(CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  ))
  context.setFillColor(CGColor(gray: 0, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.setFillColor(CGColor(gray: 1, alpha: 1))
  context.fill(CGRect(x: 0, y: height / 2, width: width, height: height - height / 2))
  return try renderer.makeTexture(from: try #require(context.makeImage()))
}

@Test func theScreenUnderAPassingFrontMovesAwayFromTheStone() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  var still = config
  still.rippleStarts = [0]
  still.rippleStrengths = [1]
  still.refraction = 0
  still.push = 0
  var pushed = still
  pushed.push = config.push

  // Just above the horizon, straight above the stone: the push points up, so
  // the black below is shoved over where white was.
  func brightness(_ c: IntroConfig) throws -> Int {
    let renderer = try IntroRenderer(config: c, width: 720, height: 450)
    let backdrop = try horizonBackdrop(renderer)
    renderer.backdrop = backdrop
    let g = renderer.geometry
    let p = SIMD2<Double>(360, 225)
    let spring = PushSpring(config: c)
    let peak = (1 ... 200).map { c.pushPeriod * Double($0) / 200 }.max { spring.response($0) < spring.response($1) }!
    let arrival = simd_distance_d(p, g.stone) / g.speed
    // The stage is fully in by the time the push peaks.
    #expect(stageCover(at: p, time: arrival + peak, geometry: g, config: c) == 1)
    let time = arrival + peak
    let frame = try renderer.renderFrame(time: time, background: backdrop)
    return Int(frame.pixel(x: 360, yUp: 225 + 3).r)
  }
  let unmoved = try brightness(still)
  let moved = try brightness(pushed)
  #expect(unmoved > 100)
  #expect(moved < unmoved / 3)
}

private func makeRenderer(width: Int = 720, height: Int = 450) throws -> IntroRenderer? {
  guard MTLCreateSystemDefaultDevice() != nil else { return nil }
  return try IntroRenderer(config: config, width: width, height: height)
}

@Test func theFirstFrameIsFullyTransparent() throws {
  guard let renderer = try makeRenderer() else { return }
  let frame = try renderer.renderFrame(time: 0)
  #expect(frame.bytes.allSatisfy { $0 == 0 })
}

@Test func onceTheLineIsSharpItIsCentredOverABottomToTopGradient() throws {
  guard let renderer = try makeRenderer() else { return }
  let frame = try renderer.renderFrame(time: config.surfaceStart)
  let bottom = frame.pixel(x: 5, yUp: 0)
  let top = frame.pixel(x: 5, yUp: frame.height - 1)
  #expect(abs(Int(bottom.a) - 240) <= 2)
  #expect(abs(Int(top.a) - 128) <= 2)
  // The ink is the tint, premultiplied: no shading or glints are left.
  #expect(Int(bottom.r) <= 6 && Int(bottom.b) <= 7)

  // Text is the only thing brighter than the tint, centred both ways.
  var minX = Int.max, maxX = 0, minY = Int.max, maxY = 0
  for y in 0 ..< frame.height {
    for x in 0 ..< frame.width where frame.pixel(x: x, yUp: y).r > 128 {
      minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
  }
  #expect(maxX > minX)
  #expect(abs(Double(minX + maxX) / 2 - Double(frame.width) / 2) < 3)
  #expect(abs(Double(minY + maxY) / 2 - Double(frame.height) / 2) < Double(frame.height) * 0.03)
}

@Test func theShaderMatchesTheReferenceDarkness() throws {
  guard let renderer = try makeRenderer() else { return }
  let g = renderer.geometry
  // Before the surfacing gathers the darkness into the @.
  for time in [0.6, 1.4, 2.5, 3.2] {
    let frame = try renderer.renderFrame(time: time)
    for p in samplePoints(g, steps: 8) {
      let x = min(Int(p.x), frame.width - 1)
      let y = min(Int(p.y), frame.height - 1)
      let sample = rippleSample(at: [Double(x) + 0.5, Double(y) + 0.5], time: time, geometry: g, config: config)
      // Away from the wave fronts and the line of text the pixel is pure darkness.
      guard abs(sample.height) < 1e-3, sample.rim < 1e-3 else { continue }
      guard abs(Double(y) - g.height / 2) > config.fontSize * g.q else { continue }
      let expected = darkness(at: [Double(x) + 0.5, Double(y) + 0.5], time: time, geometry: g, config: config)
      #expect(abs(Double(frame.pixel(x: x, yUp: y).a) / 255 - expected) < 0.01)
    }
  }
}

@Test func withAStageTheWholeScreenIsCoveredAfterTheFirstFront() throws {
  guard let renderer = try makeRenderer() else { return }
  renderer.backdrop = try horizonBackdrop(renderer)
  // Ahead of the first front the live screen shows untouched…
  let early = try renderer.renderFrame(time: 0.2)
  #expect(early.pixel(x: 360, yUp: 449).a == 0)
  // …and once every front has crossed, nothing of it shows anywhere.
  let late = try renderer.renderFrame(time: config.end)
  for p in samplePoints(renderer.geometry, steps: 8) {
    let x = min(Int(p.x), late.width - 1)
    let y = min(Int(p.y), late.height - 1)
    #expect(late.pixel(x: x, yUp: y).a == 255)
  }
}

@Test func aPlainStageStillCoversTheWholeScreen() throws {
  guard let renderer = try makeRenderer() else { return }
  let stage = try #require(plainStage(width: 720, height: 450, fill: CGColor(gray: 0, alpha: 1)))
  renderer.backdrop = try renderer.makeTexture(from: stage)
  let late = try renderer.renderFrame(time: config.end)
  for p in samplePoints(renderer.geometry, steps: 8) {
    let x = min(Int(p.x), late.width - 1)
    let y = min(Int(p.y), late.height - 1)
    #expect(late.pixel(x: x, yUp: y).a == 255)
  }
}

// The surfacing: once the line is sharp, a vast @ rises under the dark
// surface, seen only by its shadow, how it bends the stage and the light.

@Test func theSurfacingLeavesEverythingUpToTheSharpLineAsItWas() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  var other = config
  other.mark = "#"
  other.markHeight = 0.2
  other.surfaceDuration = 1
  other.markShadow = 1
  other.markBend = 0.2
  let a = try IntroRenderer(config: config, width: 360, height: 225)
  let b = try IntroRenderer(config: other, width: 360, height: 225)
  a.backdrop = try horizonBackdrop(a)
  b.backdrop = try horizonBackdrop(b)
  for time in [0.0, 0.5, 1.5, 2.5, config.surfaceStart] {
    #expect(try a.renderFrame(time: time).bytes == b.renderFrame(time: time).bytes)
  }
}

@Test func theMarkRisesFromWhereTheStoneFellToTheCentre() {
  let start = surfaceFrame(time: config.surfaceStart, config: config)
  let end = surfaceFrame(time: config.surfaceEnd, config: config)
  #expect(start.centre(reference) == reference.stone)
  #expect(end.centre(reference) == [reference.width / 2, reference.height / 2])
  #expect(end.scale(config) == 1)
  // Broad and faint deep down, defined at the surface.
  #expect(start.blur(reference, config) > 4 * end.blur(reference, config))
  #expect(start.presence == 0 && end.presence == 1)
  // The line has given way to it, and the water has gone still.
  #expect(textFrame(time: config.surfaceEnd, q: 1, config: config).opacity == 0)
  #expect(end.calm == 0)
}

/// Alpha along the row through the centre of the display.
private func centreRow(_ frame: FramePixels) -> [Int] {
  (0 ..< frame.width).map { Int(frame.pixel(x: $0, yUp: frame.height / 2).a) }
}

@Test func theDarkStaysAndDeepensUnderTheMark() throws {
  guard let renderer = try makeRenderer() else { return }
  let sharp = try renderer.renderFrame(time: config.surfaceStart)
  let surfaced = try renderer.renderFrame(time: config.end)
  // Under its body the light is held back more than the darkness alone did…
  let darknessThere = (config.darkBottom + config.darkTop) / 2
  #expect(Double(centreRow(surfaced).max()!) / 255 > darknessThere + 0.1)
  // …and away from it the dark is as it was.
  let corner = Int(surfaced.pixel(x: 5, yUp: 5).a)
  #expect(abs(corner - Int(sharp.pixel(x: 5, yUp: 5).a)) <= 3)
}

@Test func theMarkBendsTheStageAboveIt() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  var flat = config
  flat.markBend = 0
  let bent = try #require(try makeRenderer())
  let unbent = try IntroRenderer(config: flat, width: 720, height: 450)
  bent.backdrop = try horizonBackdrop(bent)
  unbent.backdrop = try horizonBackdrop(unbent)
  let a = try bent.renderFrame(time: config.end)
  let b = try unbent.renderFrame(time: config.end)
  // Only along its curves, where its surface slopes, is the horizon displaced.
  let changed = (0 ..< a.width).filter { x in
    abs(Int(a.pixel(x: x, yUp: 225).r) - Int(b.pixel(x: x, yUp: 225).r)) > 8
  }.count
  #expect(changed > 0)
  #expect(changed < a.width / 2)
}

@Test func theMarkComesIntoFocus() throws {
  guard let renderer = try makeRenderer() else { return }
  // Its steepest change in darkness across a few pixels: a rounded form, so
  // measured over a span rather than one pixel.
  func definition(_ time: Double) throws -> Int {
    let row = centreRow(try renderer.renderFrame(time: time))
    return zip(row.dropFirst(6), row).map { abs($0 - $1) }.max()!
  }
  let halfway = try definition(config.surfaceStart + config.surfaceDuration / 2)
  let surfaced = try definition(config.end)
  #expect(surfaced > halfway * 2)
}

@Test func onceSurfacedNothingMoves() throws {
  guard let renderer = try makeRenderer() else { return }
  renderer.backdrop = try horizonBackdrop(renderer)
  let surfaced = try renderer.renderFrame(time: config.surfaceEnd)
  #expect(surfaced.bytes == (try renderer.renderFrame(time: config.end)).bytes)
}

// Version 2: the same timeline, with ripples as subtle as the surfacing @.

@Test func version2SharesTheRipplesAndHasNoLine() {
  let one = IntroConfig(version: .one)
  let two = IntroConfig(version: .two)
  #expect(two.version == .two && two.ending == .still)
  // No line and nothing surfacing: its last ripple becomes the window.
  #expect(two.text.isEmpty && two.mark.isEmpty && two.phrase != nil && two.carousel == nil && one.phrase == nil)
  #expect(two.rippleStarts == one.rippleStarts && two.travel == one.travel)
  #expect(two.end < one.end)
  // Switching back restores version 1's water, line and @ exactly.
  var back = two
  back.use(.one)
  #expect(back.ending == .surfacing && back.text == one.text && back.mark == one.mark)
  #expect(back.wavelength == one.wavelength && back.refraction == one.refraction && back.waterRim == one.waterRim)
  #expect(back.fontSize == one.fontSize && back.end == one.end && back.carousel == nil && back.phrase == nil)
}

@Test func version2NeverTurnsTheScreenFullyDarkAndHoldsStill() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  let one = try IntroRenderer(config: IntroConfig(version: .one), width: 720, height: 450)
  let c = IntroConfig(version: .two)
  let two = try IntroRenderer(config: c, width: 720, height: 450)
  one.backdrop = try horizonBackdrop(one)
  two.backdrop = try horizonBackdrop(two)
  // Like version 1, the dark stays as the ripples left it, darker at the
  // bottom than the top: the stage still shows near the top while the line
  // is held.
  let held = try two.renderFrame(time: c.phrase!.handoff)
  let reference = try one.renderFrame(time: IntroConfig(version: .one).textFadeEnd)
  let top = held.pixel(x: 360, yUp: held.height - 5)
  let bottom = held.pixel(x: 360, yUp: 5)
  #expect(Int(top.r) + Int(top.g) + Int(top.b) > Int(bottom.r) + Int(bottom.g) + Int(bottom.b) + 20)
  let oneTop = reference.pixel(x: 360, yUp: reference.height - 5)
  #expect(abs(Int(top.b) - Int(oneTop.b)) <= 12)
  // The line is held still for its last moments.
  let end = try two.renderFrame(time: c.end)
  #expect(end.bytes == (try two.renderFrame(time: c.end - 0.3)).bytes)
}

@Test func version2RipplesAreSubtlerAndStillBringTheDarknessIn() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  let one = try IntroRenderer(config: IntroConfig(version: .one), width: 720, height: 450)
  let two = try IntroRenderer(config: IntroConfig(version: .two), width: 720, height: 450)
  // Over the live screen, mid-ripple: the brightest light the water adds.
  func brightest(_ renderer: IntroRenderer) throws -> Int {
    let frame = try renderer.renderFrame(time: 1.0)
    var top = 0
    for y in stride(from: 0, to: frame.height, by: 3) {
      for x in stride(from: 0, to: frame.width, by: 3) {
        let p = frame.pixel(x: x, yUp: y)
        top = max(top, Int(max(p.r, max(p.g, p.b))))
      }
    }
    return top
  }
  #expect(try brightest(two) < brightest(one) / 2)
  // Once every front has crossed, the darkness is the same.
  let darkOne = try one.renderFrame(time: IntroConfig().darknessComplete)
  let darkTwo = try two.renderFrame(time: IntroConfig().darknessComplete)
  #expect(abs(Int(darkOne.pixel(x: 360, yUp: 5).a) - Int(darkTwo.pixel(x: 360, yUp: 5).a)) <= 3)
}

@Test func theIntroClosesIntoTheWindowItIsHanded() throws {
  let target = try #require(CloseTarget(
    command: #"close {"x":240,"y":90,"width":960,"height":720,"radius":16,"color":[23,23,23]}"#
  ))
  #expect(target.cornerRadius == 16)
  #expect(target.color == SIMD3(repeating: 23.0 / 255))
  // Electron measures from the top; AppKit draws from the bottom.
  let frame = try #require(target.frame(in: CGSize(width: 1440, height: 900)))
  #expect(frame == CGRect(x: 240, y: 90, width: 960, height: 720))
  let low = try #require(CloseTarget(command: #"close {"x":0,"y":0,"width":100,"height":50,"radius":0,"color":null}"#))
  #expect(low.frame(in: CGSize(width: 1440, height: 900)) == CGRect(x: 0, y: 850, width: 100, height: 50))
  #expect(low.color == nil)
  // A window on another display, or nonsense, falls back to a plain fade.
  #expect(CloseTarget(command: #"close {"x":2000,"y":0,"width":100,"height":50}"#)?
    .frame(in: CGSize(width: 1440, height: 900)) == nil)
  #expect(CloseTarget(command: #"close {"x":0,"y":0,"width":0,"height":50}"#) == nil)
  #expect(CloseTarget(command: "dismiss") == nil)
}

// The drawn window: version 2 ends by drawing the window it lands in.

private let drawnLayout = #"""
layout {"window":{"x":60,"y":45,"width":600,"height":360,"radius":16,"color":[23,23,23]},
"elements":[
{"kind":"text","group":0,"x":110,"y":80,"width":100,"height":12,"radius":0,"color":null},
{"kind":"shape","group":1,"x":110,"y":110,"width":240,"height":50,"radius":25,"color":[38,38,38,255]},
{"kind":"shape","group":1,"x":300,"y":122,"width":36,"height":26,"radius":13,"color":[107,152,255,255]},
{"kind":"shape","group":2,"x":370,"y":110,"width":240,"height":50,"radius":25,"color":[38,38,38,255]},
{"kind":"shape","group":3,"x":500,"y":330,"width":110,"height":30,"radius":15,"color":[250,250,250,255]}]}
"""#.replacingOccurrences(of: "\n", with: "")

@Test func theWindowIsPrintedTopToBottomOnceTheLineIsHeld() throws {
  let c = IntroConfig(version: .two)
  let drawing = try #require(WindowDrawing(command: drawnLayout, origin: .zero, scale: 2, config: c))
  // Points become device pixels; the window comes first.
  #expect(drawing.shapes.count == 6)
  #expect(drawing.shapes[0].rect == CGRect(x: 120, y: 90, width: 1200, height: 720))
  #expect(drawing.shapes[2].radius == 50 && drawing.shapes[2].fill == SIMD4(38.0 / 255, 38.0 / 255, 38.0 / 255, 1))
  // It starts once the line has been printed and held.
  #expect(drawing.start == c.phrase!.handoff && drawing.printed > drawing.start && drawing.end > drawing.printed)
  #expect(drawing.end > c.end)
  // Nothing is printed before it starts, everything once it ends.
  #expect(drawing.scan(time: drawing.start) == .blank)
  #expect(drawing.scan(time: drawing.printed).isPrinted([700, 800]))
  let scan = drawing.scan(time: (drawing.start + drawing.printed) / 2)
  #expect(scan.left < 120 && scan.right > 1320 && scan.head >= scan.left && scan.head <= scan.right)
  // The window alone is a layout too: it is printed and filled.
  let alone = try #require(WindowDrawing(
    command: #"layout {"window":{"x":0,"y":0,"width":10,"height":10},"elements":[]}"#,
    origin: .zero, scale: 1, config: c
  ))
  #expect(alone.shapes.count == 1 && alone.end > alone.start && alone.heading == nil)
  #expect(WindowDrawing(command: "dismiss", origin: .zero, scale: 1, config: c) == nil)
}

@Test func thePrinterMovesInJoltsAndPassesLikeARealOne() {
  let area = CGRect(x: 100, y: 100, width: 800, height: 400)
  let bands = 4
  let (start, end) = (0.0, 4.0)
  func at(_ t: Double) -> ScanLine { scanLine(sweeping: area, bands: bands, from: start, to: end, time: t) }
  // Band 1 (of 4) runs from 1s to 2s: a feed, then a pass.
  // The feed jolts the line down a band, overshooting a little before it settles.
  let feed = (0 ..< 20).map { at(1 + 0.2 * Double($0) / 20).y }
  #expect(feed.first! < 205 && feed.max()! > 300 && abs(at(1.2).y - 300) < 1)
  // Then the paper stops dead while the head crosses: the line doesn't move.
  #expect(at(1.3).y == 300 && at(1.6).y == 300 && at(1.95).y == 300)
  // The head runs right to left on this pass (left to right on the one
  // before), slowly at the ends, and prints only behind itself.
  let early = at(1.3), middle = at(1.6)
  #expect(!early.fromLeft && at(0.6).fromLeft)
  #expect(early.head > middle.head && middle.head > at(1.9).head)
  #expect(middle.isPrinted([middle.head + 20, 250]) && !middle.isPrinted([middle.head - 20, 250]))
  #expect(middle.isPrinted([150, 150]) && !middle.isPrinted([500, 350]))
  let endSpeed = abs(at(1.24).head - at(1.25).head)
  let midSpeed = abs(at(1.6).head - at(1.61).head)
  #expect(endSpeed < midSpeed / 3)
  #expect(at(start) == .blank && at(end).isPrinted([800, 499]))
}

@Test func theLaserPrintsTheLineAtTheMiddleAfterTheRipples() throws {
  let c = IntroConfig(version: .two)
  let phrase = try #require(c.phrase)
  #expect(phrase.text == "One interface to control your agents")
  #expect(phrase.appear > c.darknessComplete && phrase.handoff > phrase.printed)
  let g = IntroGeometry(width: 1440, height: 900, config: c)
  // It sits at the middle of the display, and stays there.
  let box = phraseBox(config: c, geometry: g, width: 600, height: 60)
  #expect(box == CGRect(x: 420, y: 420, width: 600, height: 60))
  // The printer works down over it, band by band, then is done.
  #expect(phraseScan(time: phrase.appear, config: c, geometry: g, width: 600, height: 60) == .blank)
  let early = try #require(phraseScan(time: phrase.appear + 0.3, config: c, geometry: g, width: 600, height: 60))
  let late = try #require(phraseScan(time: phrase.printed - 0.1, config: c, geometry: g, width: 600, height: 60))
  #expect(early.y < late.y && early.left < 420 && early.right > 1020)
  let done = try #require(phraseScan(time: phrase.printed + 0.5, config: c, geometry: g, width: 600, height: 60))
  #expect(done.isPrinted([720, 470]) && done.opacity == 0)
}

@Test func theCarouselRollsThroughTheAgentsAndLandsOnTheHeading() throws {
  var c = IntroConfig(version: .two)
  var rolling = Carousel()
  rolling.appear = c.darknessComplete + 0.2
  rolling.firstStep = rolling.appear + rolling.appearDuration
  c.carousel = rolling
  c.phrase = nil
  let carousel = try #require(c.carousel)
  let g = IntroGeometry(width: 1440, height: 900, config: c)
  let widths = ([carousel.lead] + carousel.all).map { Double($0.count) * 30 }
  // Each word in turn is the bright one, slowing down, and it ends on "any agent".
  #expect(carousel.all.first == "Claude" && carousel.all.last == "any agent")
  for i in 1 ..< carousel.all.count {
    #expect(carousel.stepTime(i) - carousel.stepTime(i - 1) > (i > 1 ? carousel.stepTime(i - 1) - carousel.stepTime(i - 2) : 0))
  }
  func brightest(_ t: Double) -> Int? {
    carouselPlacements(time: t, config: c, geometry: g, widths: widths, heading: nil)
      .filter { $0.index > 0 }.max { $0.opacity < $1.opacity }?.index
  }
  // Nothing of it shows until the ripples have crossed the display.
  #expect(carousel.appear > c.darknessComplete && carousel.firstStep >= carousel.appear)
  #expect(carouselPlacements(time: c.darknessComplete, config: c, geometry: g, widths: widths, heading: nil).isEmpty)
  #expect(brightest(carousel.stepTime(2) + carousel.slide) == 3)
  #expect(brightest(carousel.landed) == carousel.all.count)
  // Before the hand-off its neighbours show faintly; after it only "Run any agent" is left.
  let held = carouselPlacements(time: carousel.landed, config: c, geometry: g, widths: widths, heading: nil)
  #expect(held.count > 2)
  let heading = CGRect(x: 300, y: 200, width: 200, height: 40)
  let landed = carouselPlacements(
    time: carousel.handoff + carousel.landing, config: c, geometry: g, widths: widths, heading: heading
  )
  #expect(landed.map(\.index) == [0, carousel.all.count])
  // "Run" sits on the heading's left edge, at its middle and at its size.
  let run = landed[0]
  #expect(abs(run.origin.x - 300) < 0.5 && abs(run.origin.y - 220) < 0.5)
  #expect(abs(run.scale - 40 / 1.4 / (c.fontSize * g.q)) < 1e-9)
  #expect(abs(landed[1].origin.y - 220) < 0.5 && landed[1].origin.x > run.origin.x)
}

@Test func theDrawnWindowEndsInTheRealWindowsColours() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  let c = IntroConfig(version: .two)
  let renderer = try IntroRenderer(config: c, width: 720, height: 450)
  renderer.drawing = try #require(WindowDrawing(command: drawnLayout, origin: .zero, scale: 1, config: c))
  let drawing = try #require(renderer.drawing)
  #expect(renderer.end == drawing.end)

  // Halfway through, the bands above the one being printed are there and
  // the window below it isn't yet.
  let halfway = (drawing.start + drawing.printed) / 2
  let half = try renderer.renderFrame(time: halfway)
  let scan = drawing.scan(time: halfway)
  #expect(half.pixel(x: 90, yUp: 450 - Int(scan.top) + 10).a == 255)
  #expect(half.pixel(x: 90, yUp: 450 - Int(scan.y) - 20).a < 255)

  // At the end: the window's background, the card's grey, the toggle's blue
  // and the button's white, each where the real one is.
  let end = try renderer.renderFrame(time: renderer.end)
  func near(_ p: (r: UInt8, g: UInt8, b: UInt8, a: UInt8), _ rgb: (Int, Int, Int)) -> Bool {
    abs(Int(p.r) - rgb.0) <= 3 && abs(Int(p.g) - rgb.1) <= 3 && abs(Int(p.b) - rgb.2) <= 3
  }
  #expect(near(end.pixel(x: 90, yUp: 450 - 300), (23, 23, 23)))
  #expect(near(end.pixel(x: 200, yUp: 450 - 135), (38, 38, 38)))
  #expect(near(end.pixel(x: 318, yUp: 450 - 135), (107, 152, 255)))
  #expect(near(end.pixel(x: 555, yUp: 450 - 345), (250, 250, 250)))
  // Nothing is drawn outside the window.
  #expect(end.pixel(x: 20, yUp: 20).r < 12)
}
