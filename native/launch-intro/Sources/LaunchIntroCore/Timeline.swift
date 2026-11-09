import Foundation

/// The first-launch "stone in water" intro. Every value is a pure function of
/// seconds since start, so any frame can be rendered, scrubbed or tested.
///
/// Lengths are design units on a 1440 × 900 reference display; multiply by
/// `scale(forPixelWidth:)` to get device pixels. Y grows upward from the
/// bottom edge.
public struct IntroConfig: Sendable {
  public static let referenceWidth: Double = 1440

  /// Version 1's ripples are bold: dark bands, bright rims and glints.
  /// Version 2's are seen the way the surfacing @ is: broad, low swells that
  /// bend the stage, catch a soft light and bring the darkness in under them.
  /// Both share the timeline and the surfacing.
  public enum Version: Int, Sendable, CaseIterable {
    case one = 1
    case two = 2
  }

  public private(set) var version: Version = .one

  /// What happens once the line is sharp. Version 1 raises the @ under the
  /// surface; version 2 lights the line from behind.
  public enum Ending: Sendable {
    case surfacing
    case backlit
  }

  public var ending: Ending = .surfacing

  public var text = "One interface for every agent"
  /// Design units. The approved prototype's size wasn't in the spec.
  public var fontSize: Double = 40
  public var textColor: SIMD4<Float> = [0.95, 0.95, 0.97, 1]

  /// Sent back to back, close enough to read as one train of three rings.
  /// At most four are drawn.
  public var rippleStarts: [Double] = [0, 0.3, 0.6]
  public var rippleStrengths: [Float] = [1.5, 0.65, 0.65]
  /// Time for a ripple's dark edge to clear the farthest top corner.
  public var travel: Double = 8.0 / 3.0

  /// The line starts to sharpen as the last ripple leaves the stone and is
  /// sharp once that ripple has crossed the display.
  public var textFadeStart: Double { rippleStarts.max() ?? 0 }
  public var textFadeEnd: Double { textFadeStart + travel }
  /// The surfacing begins the moment the line is sharp.
  public var surfaceStart: Double { textFadeEnd }
  public var surfaceEnd: Double { surfaceStart + surfaceDuration }
  /// The last frame; it is held until the host dismisses the overlay.
  public var end: Double { surfaceEnd + surfaceHold }

  /// Stone sits this fraction of the display height below the bottom edge.
  public var stoneDepth: Double = 0.2
  public var wavelength: Double = 46
  public var pack: Double = 180
  public var soft: Double = 160
  public var amplitude: Double = 9
  public var decay: Double = 0.375
  /// Small-scale bending along the ripple bands. Kept low: strong values tear
  /// icons apart instead of moving them.
  public var refraction: Double = 3
  /// As each front passes, the stage under it is shoved away from the stone
  /// and rides a damped spring back, so it bobs with the wave.
  /// Peak shove in design units for a full-strength ripple.
  public var push: Double = 14
  /// Seconds for one swing of the spring once a front has passed. Slow enough
  /// that the shove barely changes across an icon, so it moves whole.
  public var pushPeriod: Double = 0.8
  /// Damping ratio of that spring: lower overshoots more, but must still
  /// settle the last ripple's push before the final frame is held.
  public var pushDamping: Double = 0.5
  /// Seconds over which the shove eases in, so the front doesn't squash
  /// what it reaches.
  public var pushOnset: Double = 0.2
  /// Width of the first front's wash to the stage, as a fraction of `soft`.
  /// Narrow enough that the stage is fully in before the push peaks.
  public var stageWash: Double = 0.5
  public var maxTextBlur: Double = 14
  public var darkBottom: Double = 0.94
  public var darkTop: Double = 0.50
  /// How the water is lit in version 2: its shading, its sheen and how
  /// tightly that gathers, and the cool light along each front. Version 1's
  /// are these defaults, fixed in `ripple_fragment`.
  public var waterShade: Double = 0.30
  public var waterSheen: Double = 0.55
  public var waterSheenPower: Double = 60
  public var waterRim: Double = 0.30

  // The surfacing. The stone was the @. Once the line is sharp the water goes
  // still, and a vast @ rises from where the stone fell, under the dark
  // surface. It is never drawn: it is seen by how its rounded body bends the
  // stage above it and catches the light, and it fills the display, its ring
  // running past the edges. Deep down its form is broad and faint;
  // nearer the surface it is defined and its relief stronger. Nothing moves
  // like water from here on.

  public var mark = "@"
  /// Height of the surfaced @, as a fraction of the display height: its
  /// outer ring runs past the top and bottom edges.
  public var markHeight: Double = 0.95
  /// Font weight trait, −1 to 1. Heavy enough to read as one vast body.
  public var markWeight: Double = 0.23
  /// Seconds from the sharp line to the surfaced @.
  public var surfaceDuration: Double = 5
  /// Seconds the surfaced @ is held still before the last frame.
  public var surfaceHold: Double = 1
  /// Seconds over which what is left of the water's motion settles.
  public var calmDuration: Double = 1.5
  /// The @'s size deep down, relative to its surfaced size.
  public var markDepthScale: Double = 0.85
  /// How rounded the body is deep down and once surfaced: the blur of its
  /// form, as a fraction of the display height.
  public var markDepthBlur: Double = 0.12
  public var markSurfacedBlur: Double = 0.022
  /// Steepest slope of the body's surface once surfaced.
  public var markRelief: Double = 0.45
  /// How far the stage bends at that slope, as a fraction of the display height.
  public var markBend: Double = 0.03
  /// How strongly its surface is lit and shaded, and its wet highlight.
  public var markShade: Double = 0.2
  public var markShine: Double = 0.16
  /// How much of the light passing through its body it holds back: the
  /// darkness was its shadow.
  public var markShadow: Double = 0.6

  // The backlit ending. The dark becomes a solid plane with the line cut
  // through it, and a light behind it, up and to the left of the first
  // letter, shines through: the letters glow hottest nearest the light, and
  // their shafts fan away from it in a wedge that points back at the light,
  // the way Pipper's cursor points.

  /// The light's colour at the source, through the middle of the line, to its
  /// far end.
  public var lightHot: SIMD3<Float> = [1, 0.96, 0.88]
  public var lightWarm: SIMD3<Float> = [1, 0xAA / 255, 0x4F / 255]
  public var lightFar: SIMD3<Float> = [0.86, 0.24, 0.07]
  /// Where the light sits, in design units from the first letter's left edge
  /// and the line's middle, y up.
  public var lightOffset: SIMD2<Double> = [-44, 5]
  /// How far each shaft reaches beyond its letter, as a fraction of the
  /// display height.
  public var shaftLength: Double = 0.85
  /// How much dimmer the far end of the line is than the letter nearest the
  /// light: 0 even, 2 a third as bright.
  public var lightFalloff: Double = 2.2
  /// Brightness of the shafts, of the lit letters, and of the glow at the source.
  public var shaftStrength: Double = 14
  public var letterGlow: Double = 1.6
  public var letterBloom: Double = 0.5
  /// How quickly the beams weaken along the line: higher keeps them to the
  /// first few letters.
  public var shaftFalloff: Double = 7
  /// How much warmer the beams are than their letters, along the colour run
  /// from hot to far.
  public var shaftWarmth: Double = 0.45
  /// Overall brightness before the highlights roll off.
  public var lightExposure: Double = 1.5
  /// How soft the beams are, in design units: the blur of the line they are
  /// traced from.
  public var beamSoftness: Double = 4
  public var sourceGlow: Double = 0
  /// How dark the plane the line is cut from becomes.
  public var planeDarkness: Double = 0.985

  public init() {}

  public init(version: Version) {
    use(version)
  }

  /// Switches the water's look; the timeline, text and surfacing are shared.
  public mutating func use(_ version: Version) {
    let base = IntroConfig()
    self.version = version
    switch version {
    case .one:
      ending = base.ending
      text = base.text
      mark = base.mark
      wavelength = base.wavelength
      amplitude = base.amplitude
      pack = base.pack
      soft = base.soft
      refraction = base.refraction
      push = base.push
      waterShade = base.waterShade
      waterSheen = base.waterSheen
      waterSheenPower = base.waterSheenPower
      waterRim = base.waterRim
    case .two:
      // The line is lit from behind instead of anything surfacing.
      ending = .backlit
      text = "One interface to control your agents"
      fontSize = 52
      mark = ""
      // Long, low swells: a gentle slope, so the shading stays soft, but
      // enough bending that the stage visibly moves under each one.
      wavelength = 150
      amplitude = 7
      pack = 300
      soft = 300
      refraction = 30
      push = 9
      waterShade = 0.14
      waterSheen = 0.16
      waterSheenPower = 14
      waterRim = 0.03
    }
  }

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
    let fade = exp(-age * c.decay)
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

/// The line sharpens in, then, as the @ comes into focus, softens away: the
/// focus passes from it to the @.
public func textFrame(time t: Double, q: Double, config c: IntroConfig) -> TextFrame {
  guard t > c.surfaceStart else {
    let p = min(1, max(0, (t - c.textFadeStart) / (c.textFadeEnd - c.textFadeStart)))
    return TextFrame(opacity: p * p * (3 - 2 * p), blur: (1 - p) * c.maxTextBlur * q)
  }
  if c.ending == .backlit {
    // The white line gives way to the light coming through it, as fast as the
    // light spreads along it, so no letter goes dark before the light arrives.
    return TextFrame(opacity: 1 - surfaceFrame(time: t, config: c).rise, blur: 0)
  }
  let away = surfaceFrame(time: t, config: c).textAway
  // Gone before it is blurred enough to smear into a streak.
  return TextFrame(opacity: (1 - away) * (1 - away), blur: away * c.maxTextBlur * q)
}

public func smootherstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
  let t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/// The surfacing at one moment. Every value holds still before
/// `surfaceStart` (water calm 1, the rest 0) and after `surfaceEnd`.
public struct SurfaceFrame: Sendable, Equatable {
  /// What is left of the water's motion: shading, shove and bending. 1 until
  /// the line is sharp, then settles to 0.
  public var calm: Double
  /// How far the @ has risen from where the stone fell to the centre.
  public var rise: Double
  /// How defined its form has become, 0 to 1.
  public var focus: Double
  /// How strongly it is felt: its relief, bending and light.
  public var presence: Double
  /// How far the line has softened away.
  public var textAway: Double

  /// The @'s size relative to its surfaced size.
  public func scale(_ c: IntroConfig) -> Double { c.markDepthScale + (1 - c.markDepthScale) * rise }

  /// Where the @'s centre is, in device pixels, y up: under the stone deep
  /// down, the middle of the display once surfaced.
  public func centre(_ g: IntroGeometry) -> SIMD2<Double> {
    [g.width / 2, g.stone.y + (g.height / 2 - g.stone.y) * rise]
  }

  /// How rounded its form is, in device pixels. Eased in log space, so it
  /// defines steadily rather than all at the end.
  public func blur(_ g: IntroGeometry, _ c: IntroConfig) -> Double {
    let surfaced = max(1, c.markSurfacedBlur * g.height)
    let deep = max(surfaced, c.markDepthBlur * g.height)
    return exp(log(deep) + (log(surfaced) - log(deep)) * focus)
  }
}

public func surfaceFrame(time t: Double, config c: IntroConfig) -> SurfaceFrame {
  let elapsed = t - c.surfaceStart
  let s = min(1, max(0, elapsed / max(1e-6, c.surfaceDuration)))
  if c.ending == .backlit {
    // rise: how far along the line the light has spread from the first
    // letter; focus: how far the shafts reach; presence: how bright it is.
    return SurfaceFrame(
      calm: elapsed <= 0 ? 1 : 1 - smootherstep(0, max(1e-6, c.calmDuration), elapsed),
      rise: smootherstep(0.05, 0.75, s),
      focus: smootherstep(0.1, 1, s),
      presence: smootherstep(0, 0.45, s),
      textAway: 0
    )
  }
  return SurfaceFrame(
    calm: elapsed <= 0 ? 1 : 1 - smootherstep(0, max(1e-6, c.calmDuration), elapsed),
    rise: smootherstep(0, 0.9, s),
    focus: smootherstep(0, 1, s),
    presence: smootherstep(0, 0.75, s),
    textAway: smootherstep(0.05, 0.45, s)
  )
}
