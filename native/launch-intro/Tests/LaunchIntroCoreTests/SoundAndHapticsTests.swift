import Foundation
@testable import LaunchIntroCore
import Testing

private func rms(_ audio: StereoAudio, from a: Double, to b: Double) -> Double {
  let first = max(0, Int(a * audio.sampleRate))
  let last = min(audio.left.count, Int(b * audio.sampleRate))
  guard first < last else { return 0 }
  var sum = 0.0
  for i in first ..< last { sum += Double(audio.left[i] * audio.left[i] + audio.right[i] * audio.right[i]) / 2 }
  return (sum / Double(last - first)).squareRoot()
}

@Test func theScoreLastsThroughTheRevealAndRingsOut() {
  let config = IntroConfig()
  let audio = renderScore(config)
  #expect(audio.duration >= config.end + 2)
  let opening = rms(audio, from: config.revealStart, to: config.revealStart + 0.4)
  #expect(opening > 0.005)
  #expect(rms(audio, from: audio.duration - 0.05, to: audio.duration) < opening / 4)
}

@Test func theWelcomeIsHeardAsItSharpensAndEasesAwayWithTheReveal() {
  let config = IntroConfig()
  let audio = renderScore(config)
  // Swells in with the line…
  let held = rms(audio, from: config.textFadeEnd + 0.3, to: config.textFadeEnd + 0.8)
  #expect(held > 0.01)
  // …and has eased away once the window is revealed.
  #expect(rms(audio, from: config.revealEnd + 1.2, to: config.revealEnd + 1.7) < held / 2)
}

@Test func theScoreNeverClipsAndIsTheSameEveryTime() {
  let first = renderScore(IntroConfig())
  #expect(first.left.allSatisfy { abs($0) <= 1 } && first.right.allSatisfy { abs($0) <= 1 })
  #expect(first.left == renderScore(IntroConfig()).left)
}

@Test func eachRippleIsHeardAsItLeavesTheStoneAndAStrongerOneIsLouder() {
  // Spread the ripples out so each can be heard on its own.
  var config = IntroConfig()
  config.rippleStarts = [0, 1.2, 2.4]
  config.rippleStrengths = [1.5, 0.65, 0.65]
  let audio = renderScore(config)
  var onsets: [Double] = []
  for start in config.rippleStarts {
    let before = rms(audio, from: start - 0.03, to: start)
    let after = rms(audio, from: start, to: start + 0.03)
    #expect(after > before * 1.5)
    onsets.append(after)
  }
  #expect(onsets[0] > onsets[1] * 1.5)
}

@Test func eachFrontIsFeltOnceAsItPassesUnderThePointerInOrder() {
  let config = IntroConfig()
  let g = IntroGeometry(width: 1440, height: 900, config: config)
  let pointer = SIMD2<Double>(300, 600)
  var felt: [(time: Double, pulse: HapticPulse)] = []
  var t = 0.0
  while t < config.end {
    let next = t + 1.0 / 60
    felt += hapticPulses(at: pointer, from: t, to: next, geometry: g, config: config).map { (next, $0) }
    t = next
  }
  let fronts = felt.filter { $0.pulse.kind == .front }
  #expect(fronts.map(\.pulse.taps) == [3, 1, 1])
  #expect(fronts.map(\.pulse.firm) == [true, false, false])
  #expect(fronts.map(\.time) == fronts.map(\.time).sorted())
  #expect(felt.filter { $0.pulse.kind == .settle }.count == 1)
  // Farther from the stone, the same front arrives later.
  let near = hapticPulses(at: [720, 50], from: 0, to: 0.5, geometry: g, config: config)
  let far = hapticPulses(at: [0, 900], from: 0, to: 0.5, geometry: g, config: config)
  #expect(near.contains { $0.kind == .front })
  #expect(!far.contains { $0.kind == .front })
}
