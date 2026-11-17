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
  // A front's soft dark edge has just cleared the farthest top corner.
  let far = simd_distance_d(reference.stone, [0, reference.height])
  #expect(abs(reference.speed * config.travel - (far + config.soft * reference.q)) < 1e-6)
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
  // Spread out so each ripple's soft edge passes before the next arrives.
  var spread = config
  spread.rippleStarts = [0, 1.5, 3]
  let g = IntroGeometry(width: 1440, height: 900, config: spread)
  let p = SIMD2<Double>(720, 0)
  let d = simd_distance_d(p, g.stone)
  for (k, start) in spread.rippleStarts.enumerated() {
    let t = start + (d + spread.soft * g.q) / g.speed + 1e-4
    #expect(abs(rippleSample(at: p, time: t, geometry: g, config: spread).fill - Double(k + 1) / 3) < 1e-6)
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
  // The stage must be at rest by the time the reveal opens onto Pipper.
  let retina = IntroGeometry(width: 2880, height: 1800, config: config)
  for p in samplePoints(retina) {
    let push = pushOffset(at: p, time: config.revealStart, geometry: retina, config: config)
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
  // A narrow wash, so the stage is fully in before the push peaks and only
  // the push can move what is seen.
  still.soft = 160
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
  let frame = try renderer.renderFrame(time: config.textFadeEnd)
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
  // While the swells cross, before the welcome sharpens in.
  for time in [0.6, 1.4, 2.5] {
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
  // …and once every front has crossed, nothing of it shows anywhere until
  // the reveal opens onto it.
  let late = try renderer.renderFrame(time: config.revealStart)
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
  let late = try renderer.renderFrame(time: config.revealStart)
  for p in samplePoints(renderer.geometry, steps: 8) {
    let x = min(Int(p.x), late.width - 1)
    let y = min(Int(p.y), late.height - 1)
    #expect(late.pixel(x: x, yUp: y).a == 255)
  }
}

@Test func theDarkStaysAsTheSwellsLeftItWhileTheWelcomeIsHeld() throws {
  guard let renderer = try makeRenderer() else { return }
  renderer.backdrop = try horizonBackdrop(renderer)
  // Darker at the bottom than the top: the stage still shows near the top,
  // so the screen never turns fully dark.
  let held = try renderer.renderFrame(time: config.revealStart - 0.5)
  let top = held.pixel(x: 360, yUp: held.height - 5)
  let bottom = held.pixel(x: 360, yUp: 5)
  #expect(Int(top.r) + Int(top.g) + Int(top.b) > Int(bottom.r) + Int(bottom.g) + Int(bottom.b) + 20)
}

@Test func theSwellsAreSubtle() throws {
  guard let renderer = try makeRenderer() else { return }
  // Over the live screen, mid-swell: the light the water adds stays faint, so
  // the swells are seen by how they bend the stage, not as bright bands.
  let frame = try renderer.renderFrame(time: 1.0)
  var brightest = 0
  for y in stride(from: 0, to: frame.height, by: 3) {
    for x in stride(from: 0, to: frame.width, by: 3) {
      let p = frame.pixel(x: x, yUp: y)
      brightest = max(brightest, Int(max(p.r, max(p.g, p.b))))
    }
  }
  #expect(brightest < 60)
}
