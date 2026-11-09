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

@Test func version2SharesTheTimelineAndLightsTheLineFromBehind() {
  let one = IntroConfig(version: .one)
  let two = IntroConfig(version: .two)
  #expect(two.version == .two && two.ending == .backlit)
  #expect(two.text == "One interface to control your agents" && two.mark.isEmpty)
  #expect(two.rippleStarts == one.rippleStarts && two.travel == one.travel)
  #expect(two.surfaceStart == one.surfaceStart && two.end == one.end)
  // The line stays; only its white gives way to the light through it.
  #expect(textFrame(time: two.end, q: 1, config: two).opacity == 0)
  #expect(textFrame(time: two.surfaceStart, q: 1, config: two).opacity == 1)
  // Switching back restores version 1's water, line and @ exactly.
  var back = two
  back.use(.one)
  #expect(back.ending == .surfacing && back.text == one.text && back.mark == one.mark)
  #expect(back.wavelength == one.wavelength && back.refraction == one.refraction && back.waterRim == one.waterRim)
}

/// The line's ink box in a frame, y up, from where it is brighter than the plane.
private func litLine(_ frame: FramePixels) -> (minX: Int, maxX: Int, midY: Int)? {
  var minX = Int.max, maxX = 0, minY = Int.max, maxY = 0
  for y in 0 ..< frame.height {
    for x in 0 ..< frame.width {
      let p = frame.pixel(x: x, yUp: y)
      guard Int(p.r) + Int(p.g) > 300 else { continue }
      minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
  }
  return maxX > minX ? (minX, maxX, (minY + maxY) / 2) : nil
}

@Test func version2LightsTheLineHottestNearestTheLightWithAWedgeOfBeams() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  let c = IntroConfig(version: .two)
  let renderer = try IntroRenderer(config: c, width: 720, height: 450)
  let sharp = try renderer.renderFrame(time: c.surfaceStart)
  let lit = try renderer.renderFrame(time: c.end)
  let line = try #require(litLine(lit))

  // The first letters burn near white; the far end of the line is red-orange.
  func colour(_ x0: Int, _ x1: Int) -> (r: Int, b: Int) {
    var r = 0, b = 0
    for x in x0 ..< x1 {
      for y in line.midY - 8 ... line.midY + 8 {
        let p = lit.pixel(x: x, yUp: y)
        if Int(p.r) > r { r = Int(p.r); b = Int(p.b) }
      }
    }
    return (r, b)
  }
  let start = colour(line.minX, line.minX + 20)
  let end = colour(line.maxX - 30, line.maxX)
  #expect(start.r > 230 && start.b > 150)
  #expect(end.r > 120 && end.b < end.r / 2)

  // Beams fan out from the start of the line, above and below it, where there
  // was only dark before; away from the wedge it stays dark.
  // The light sits a little above the line, so the wedge opens more below it.
  let below = (x: line.minX + 60, y: line.midY - 30)
  let above = (x: line.minX + 120, y: line.midY + 24)
  for p in [below, above] {
    #expect(Int(lit.pixel(x: p.x, yUp: p.y).r) > Int(sharp.pixel(x: p.x, yUp: p.y).r) + 15)
  }
  #expect(lit.pixel(x: line.maxX, yUp: min(lit.height - 1, line.midY + 160)).r < 30)
}

@Test func version2ClosesTheDarkIntoAPlaneAndHoldsStill() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  let c = IntroConfig(version: .two)
  let renderer = try IntroRenderer(config: c, width: 720, height: 450)
  renderer.backdrop = try horizonBackdrop(renderer)
  let end = try renderer.renderFrame(time: c.end)
  // Away from the light, almost nothing of the stage shows through.
  let corner = end.pixel(x: 5, yUp: end.height - 5)
  #expect(corner.a == 255 && max(corner.r, corner.g, corner.b) < 12)
  #expect(end.bytes == (try renderer.renderFrame(time: c.surfaceEnd)).bytes)
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
