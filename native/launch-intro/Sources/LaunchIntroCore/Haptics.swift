/// The intro's haptics: each ripple is felt as its front passes under the
/// pointer, with more taps for a stronger ripple, once more when the text is
/// sharp, and once, softly, when the @ has surfaced. The pointer is read live,
/// so moving it moves where the wave is felt.
public struct HapticPulse: Sendable, Equatable {
  public enum Kind: Sendable {
    /// A ripple front reached the pointer.
    case front
    /// The line of text finished sharpening.
    case settle
    /// The @ finished surfacing.
    case surfaced
  }

  public var kind: Kind
  public var taps: Int
  /// Stronger fronts use the firmer pattern.
  public var firm: Bool
}

/// Taps for a ripple: the 1.5 opener gets three, the 0.65 followers one.
public func hapticTaps(strength: Float) -> Int {
  max(1, Int((Double(strength) * 2).rounded()))
}

/// Pulses due in `(from, to]` for a pointer at `p` (device pixels, y up).
public func hapticPulses(
  at p: SIMD2<Double>, from t0: Double, to t1: Double, geometry g: IntroGeometry, config c: IntroConfig
) -> [HapticPulse] {
  guard t1 > t0 else { return [] }
  let distance = simd_distance_d(p, g.stone)
  var pulses: [HapticPulse] = []
  // Fronts are felt only when there are ripples to feel.
  for (index, start) in c.rippleStarts.enumerated() where c.opening == .ripples {
    let arrival = start + distance / g.speed
    guard arrival > t0, arrival <= t1 else { continue }
    let strength = c.rippleStrengths[index]
    pulses.append(HapticPulse(kind: .front, taps: hapticTaps(strength: strength), firm: strength >= 1))
  }
  if c.textFadeEnd > t0, c.textFadeEnd <= t1 {
    pulses.append(HapticPulse(kind: .settle, taps: 1, firm: false))
  }
  if c.surfaceEnd > t0, c.surfaceEnd <= t1 {
    pulses.append(HapticPulse(kind: .surfaced, taps: 1, firm: false))
  }
  return pulses
}
