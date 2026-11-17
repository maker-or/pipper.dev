import Foundation

/// The first-launch intro: subtle swells roll across the screen from a stone
/// dropped just below its bottom edge and darken it, "Welcome to Pipper Code"
/// sharpens in at the centre, and then a wave from the centre opens the
/// overlay onto the real onboarding window underneath. Every value is a pure
/// function of seconds since start, so any frame can be rendered, scrubbed or
/// tested.
///
/// Lengths are design units on a 1440 × 900 reference display; multiply by
/// `scale(forPixelWidth:)` to get device pixels. Y grows upward from the
/// bottom edge.
public struct IntroConfig: Sendable {
  public static let referenceWidth: Double = 1440

  public var text = "Welcome to Pipper Code"
  public var fontSize: Double = 64
  public var textColor: SIMD4<Float> = [0.95, 0.95, 0.97, 1]

  /// Sent back to back, close enough to read as one train of three swells.
  /// At most four are drawn.
  public var rippleStarts: [Double] = [0, 0.3, 0.6]
  public var rippleStrengths: [Float] = [1.5, 0.65, 0.65]
  /// Time for a ripple's dark edge to clear the farthest top corner.
  public var travel: Double = 8.0 / 3.0

  /// The line starts to sharpen just before the last swell has crossed the
  /// display, and is sharp `textFadeDuration` later.
  public var textLead: Double = 0.4
  public var textFadeDuration: Double = 1.2
  public var textFadeStart: Double { darknessComplete - textLead }
  public var textFadeEnd: Double { textFadeStart + textFadeDuration }
  public var maxTextBlur: Double = 14

  /// The welcome is held this long once sharp, then the reveal starts.
  public var welcomeHold: Double = 1.4
  public var revealDuration: Double = 1.9
  /// Width of the reveal's soft edge, in design units.
  public var revealSoft: Double = 220
  /// Brightness of the cool light along the reveal's edge.
  public var revealRim: Double = 0.10
  public var revealStart: Double { textFadeEnd + welcomeHold }
  public var revealEnd: Double { revealStart + revealDuration }
  /// The host shows the window this long before the reveal starts, so it is
  /// on screen when the first pixels open.
  public static let revealLead: Double = 0.5

  /// The last frame: nothing of the overlay is left. Held until the host
  /// dismisses it.
  public var end: Double { revealEnd + 0.1 }

  /// Stone sits this fraction of the display height below the bottom edge.
  public var stoneDepth: Double = 0.2
  /// Long, low swells: a gentle slope, so the shading stays soft, but enough
  /// bending that the stage visibly moves under each one.
  public var wavelength: Double = 150
  public var pack: Double = 300
  public var soft: Double = 300
  public var amplitude: Double = 7
  public var decay: Double = 0.375
  public var refraction: Double = 30
  /// As each front passes, the stage under it is shoved away from the stone
  /// and rides a damped spring back, so it bobs with the wave.
  /// Peak shove in design units for a full-strength ripple.
  public var push: Double = 9
  /// Seconds for one swing of the spring once a front has passed. Slow enough
  /// that the shove barely changes across an icon, so it moves whole.
  public var pushPeriod: Double = 0.8
  /// Damping ratio of that spring: lower overshoots more, but must still
  /// settle the last ripple's push before the reveal.
  public var pushDamping: Double = 0.5
  /// Seconds over which the shove eases in, so the front doesn't squash
  /// what it reaches.
  public var pushOnset: Double = 0.2
  /// Width of the first front's wash to the stage, as a fraction of `soft`.
  /// Narrow enough that the stage is fully in before the push peaks.
  public var stageWash: Double = 0.5
  public var darkBottom: Double = 0.94
  public var darkTop: Double = 0.50
  /// How the water is lit: its shading, its sheen and how tightly that
  /// gathers, and the cool light along each front.
  public var waterShade: Double = 0.14
  public var waterSheen: Double = 0.16
  public var waterSheenPower: Double = 14
  public var waterRim: Double = 0.03
  /// Seconds over which the water's motion settles once the line is sharp.
  public var calmDuration: Double = 1.5
  /// Seconds over which a new swell's shape and light ease in. The long swells
  /// reach ahead of their front, so without this the first frame would
  /// already light the bottom edge before anything has started.
  public var swellOnset: Double = 0.25

  public init() {}

  public var darknessComplete: Double { (rippleStarts.max() ?? 0) + travel }

  public static func scale(forPixelWidth width: Double) -> Double { width / referenceWidth }
}

/// Display geometry in device pixels, y up.
public struct IntroGeometry: Sendable {
  public let width: Double
  public let height: Double
  public let q: Double
  public let stone: SIMD2<Double>
  /// Device pixels per second.
  public let speed: Double

  public init(width: Double, height: Double, config: IntroConfig) {
    self.width = width
    self.height = height
    q = IntroConfig.scale(forPixelWidth: width)
    stone = [width / 2, -config.stoneDepth * height]
    let farDistance = max(
      simd_distance_d(stone, [0, height]),
      simd_distance_d(stone, [width, height])
    )
    speed = (farDistance + config.soft * q) / config.travel
  }
}

@inline(__always)
func simd_distance_d(_ a: SIMD2<Double>, _ b: SIMD2<Double>) -> Double {
  let d = a - b
  return (d.x * d.x + d.y * d.y).squareRoot()
}

public func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
  let t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/// What the ripples contribute at one pixel. Mirrors `rippleField` in
/// Shaders.swift; the GPU tests hold the two together.
public struct RippleSample: Sendable {
  public var fill: Double
  public var height: Double
  public var rim: Double
}

public func rippleSample(
  at p: SIMD2<Double>, time t: Double, geometry g: IntroGeometry, config c: IntroConfig
) -> RippleSample {
  let q = g.q
  let wavelength = c.wavelength * q
  let soft = c.soft * q
  let rimSoft = soft * 0.35
  let d = simd_distance_d(p, g.stone)
  var sample = RippleSample(fill: 0, height: 0, rim: 0)
  let weight = 1 / Double(c.rippleStarts.count)
  for (index, start) in c.rippleStarts.enumerated() {
    let age = t - start
    if age < 0 { continue }
    let strength = Double(c.rippleStrengths[index])
    let x = d - age * g.speed
    sample.fill += weight * (1 - smoothstep(-soft, 0, x))
    let s = x > 0 ? wavelength * 0.6 : c.pack * q
    let envelope = exp(-(x * x) / (s * s))
    let fade = exp(-age * c.decay) * smoothstep(0, c.swellOnset, age)
    sample.height += strength * c.amplitude * q * fade * envelope * sin(x * 2 * .pi / wavelength)
    sample.rim += strength * fade * exp(-(x * x) / (rimSoft * rimSoft))
  }
  return sample
}

/// The spring a pushed pixel rides once a front has passed it:
/// `norm · smoothstep(0, onset, τ) · e^(−decay·τ) · sin(omega·τ)`,
/// normalised so its first peak is 1.
public struct PushSpring: Sendable {
  public let omega: Double
  public let decay: Double
  public let onset: Double
  public let norm: Double

  public init(config c: IntroConfig) {
    let omega = 2 * .pi / c.pushPeriod
    let zeta = min(0.95, max(0.01, c.pushDamping))
    let decay = omega * zeta / (1 - zeta * zeta).squareRoot()
    let onset = max(1e-3, c.pushOnset)
    self.omega = omega
    self.decay = decay
    self.onset = onset
    // The eased onset moves the first peak, so find it by sampling.
    var peak = 0.0
    for step in 1 ... 400 {
      let tau = c.pushPeriod * Double(step) / 400
      peak = max(peak, smoothstep(0, onset, tau) * exp(-decay * tau) * sin(omega * tau))
    }
    norm = peak > 0 ? 1 / peak : 0
  }

  /// Response `tau` seconds after the front arrived; 0 before it.
  public func response(_ tau: Double) -> Double {
    tau <= 0 ? 0 : norm * smoothstep(0, onset, tau) * exp(-decay * tau) * sin(omega * tau)
  }
}

/// How far the stage at a pixel is shoved, in device pixels, y up.
/// Points away from the stone while the wave lifts it, back as it settles.
/// Mirrors `pushField` in Shaders.swift.
public func pushOffset(
  at p: SIMD2<Double>, time t: Double, geometry g: IntroGeometry, config c: IntroConfig
) -> SIMD2<Double> {
  let spring = PushSpring(config: c)
  let delta = p - g.stone
  let d = simd_distance_d(p, g.stone)
  guard d > 0 else { return .zero }
  var amount = 0.0
  for (index, start) in c.rippleStarts.enumerated() {
    let tau = t - start - d / g.speed
    amount += Double(c.rippleStrengths[index]) * spring.response(tau)
  }
  return delta / d * (amount * c.push * g.q)
}

/// How much of the stage covers the screen at a pixel, 0 to 1. The first
/// front washes everything on screen away to the backdrop (the wallpaper),
/// so from then on everything visible is the overlay's own and can move.
/// Mirrors `stage` in Shaders.swift.
public func stageCover(at p: SIMD2<Double>, time t: Double, geometry g: IntroGeometry, config c: IntroConfig) -> Double {
  guard let first = c.rippleStarts.min(), t >= first else { return 0 }
  let x = simd_distance_d(p, g.stone) - (t - first) * g.speed
  return 1 - smoothstep(-c.soft * c.stageWash * g.q, 0, x)
}

/// Darkness alpha at a pixel from the ripples, before shading, glints and
/// the surfacing gathers it into the @.
public func darkness(at p: SIMD2<Double>, time t: Double, geometry g: IntroGeometry, config c: IntroConfig) -> Double {
  let fill = rippleSample(at: p, time: t, geometry: g, config: c).fill
  let y01 = min(1, max(0, p.y / g.height))
  return (c.darkBottom + (c.darkTop - c.darkBottom) * y01) * min(1, max(0, fill))
}

public struct TextFrame: Sendable, Equatable {
  public var opacity: Double
  /// Gaussian standard deviation in device pixels.
  public var blur: Double
}

/// The welcome sharpens in from a blur, is held, then softens away just as
/// the reveal sets off from under it.
public func textFrame(time t: Double, q: Double, config c: IntroConfig) -> TextFrame {
  let away = smootherstep(c.revealStart - 0.45, c.revealStart + 0.15, t)
  if away > 0 {
    return TextFrame(opacity: (1 - away) * (1 - away), blur: away * c.maxTextBlur * 0.6 * q)
  }
  let p = min(1, max(0, (t - c.textFadeStart) / (c.textFadeEnd - c.textFadeStart)))
  return TextFrame(opacity: p * p * (3 - 2 * p), blur: (1 - p) * c.maxTextBlur * q)
}

public func smootherstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
  let t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/// What is left of the water's motion (shading, shove and bending): 1 until
/// the line is sharp, then it settles to 0. Its darkness stays.
public func waterMotion(time t: Double, config c: IntroConfig) -> Double {
  let elapsed = t - c.textFadeEnd
  return elapsed <= 0 ? 1 : 1 - smootherstep(0, max(1e-6, c.calmDuration), elapsed)
}

/// The reveal at one moment: how far it has spread from the middle of the
/// display, in device pixels, and how soft its edge is.
public struct RevealFrame: Sendable, Equatable {
  public var radius: Double
  public var soft: Double
  public var rim: Double
}

/// Nil before the reveal starts. It eases out gently: a little quicker
/// leaving the middle than reaching the corners, so it reads as a wave
/// spreading rather than a hole popping open.
public func revealFrame(time t: Double, geometry g: IntroGeometry, config c: IntroConfig) -> RevealFrame? {
  guard t > c.revealStart else { return nil }
  let soft = c.revealSoft * g.q
  let far = (g.width * g.width + g.height * g.height).squareRoot() / 2 + soft
  let p = min(1, max(0, (t - c.revealStart) / max(1e-6, c.revealDuration)))
  let eased = 1 - (1 - p) * (1 - p)
  return RevealFrame(radius: eased * far, soft: soft, rim: c.revealRim * (1 - p))
}

/// How much of the overlay is left at a pixel, 0 (open onto the window
/// underneath) to 1. Mirrors `reveal_fragment` in Shaders.swift.
public func revealKeep(at p: SIMD2<Double>, time t: Double, geometry g: IntroGeometry, config c: IntroConfig) -> Double {
  guard let frame = revealFrame(time: t, geometry: g, config: c) else { return 1 }
  let d = simd_distance_d(p, [g.width / 2, g.height / 2])
  return smoothstep(frame.radius - frame.soft, frame.radius, d)
}
