import Foundation
@testable import LaunchIntroCore
import Metal
import Testing

/// The ending: once the welcome has been held, a wave from the middle opens
/// the overlay onto the real window underneath.
private let config = IntroConfig()

@Test func theSwellsThenTheWelcomeThenTheReveal() {
  #expect(config.text == "Welcome to Pipper Code")
  // In order: the swells cross, then the welcome sharpens, is held, then the wave.
  #expect(config.textFadeStart >= config.darknessComplete - 0.5)
  #expect(config.textFadeEnd < config.revealStart - 1)
  #expect(config.end >= config.revealEnd)
  // The welcome is sharp while held, and gone by the time the wave has left it.
  let held = textFrame(time: (config.textFadeEnd + config.revealStart) / 2, q: 1, config: config)
  #expect(held.opacity == 1 && held.blur == 0)
  #expect(textFrame(time: config.revealStart + 0.2, q: 1, config: config).opacity == 0)
  // The water has settled by the time it opens.
  #expect(waterMotion(time: config.revealEnd, config: config) == 0)
}

@Test func theRevealOpensFromTheMiddleOutToEveryCorner() {
  let g = IntroGeometry(width: 1440, height: 900, config: config)
  let middle = SIMD2(g.width / 2, g.height / 2)
  let corners: [SIMD2<Double>] = [[0, 0], [g.width, 0], [0, g.height], [g.width, g.height]]
  // Before: everything covered.
  for p in corners + [middle] { #expect(revealKeep(at: p, time: config.revealStart, geometry: g, config: config) == 1) }
  // Partway: open in the middle, still covered at the corners.
  let partway = config.revealStart + config.revealDuration * 0.3
  #expect(revealKeep(at: middle, time: partway, geometry: g, config: config) == 0)
  for p in corners { #expect(revealKeep(at: p, time: partway, geometry: g, config: config) == 1) }
  // It only ever opens further.
  var previous = 1.0
  for step in 0 ... 40 {
    let t = config.revealStart + config.revealDuration * Double(step) / 40
    let keep = revealKeep(at: [g.width * 0.8, g.height * 0.3], time: t, geometry: g, config: config)
    #expect(keep <= previous + 1e-9)
    previous = keep
  }
  // After: open everywhere, corners included.
  for p in corners + [middle] { #expect(revealKeep(at: p, time: config.revealEnd, geometry: g, config: config) == 0) }
}

@Test func theRevealedOverlayIsTrulyTransparent() throws {
  guard MTLCreateSystemDefaultDevice() != nil else { return }
  let renderer = try IntroRenderer(config: config, width: 720, height: 450)
  // Held on the welcome: the dark covers the screen.
  let held = try renderer.renderFrame(time: config.revealStart - 0.6)
  #expect(held.pixel(x: 360, yUp: 225).a > 100)
  #expect(held.pixel(x: 5, yUp: 5).a > 100)
  // Partway: the middle is open onto what is underneath, the corners not yet.
  let partway = try renderer.renderFrame(time: config.revealStart + config.revealDuration * 0.3)
  #expect(partway.pixel(x: 360, yUp: 225).a == 0)
  #expect(partway.pixel(x: 2, yUp: 2).a > 100)
  // The last frame leaves nothing of the overlay on screen.
  let last = try renderer.renderFrame(time: config.end)
  #expect(last.bytes.allSatisfy { $0 == 0 })
}
