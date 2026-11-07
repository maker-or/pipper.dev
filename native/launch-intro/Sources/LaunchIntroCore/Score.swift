import Foundation

/// The intro's sound, written against the same timeline as the visuals: every
/// event below is derived from `IntroConfig`, so retiming the ripples retimes
/// the music with them.
///
/// - Each ripple leaving the stone: a water drop and a sub thump, scaled by
///   that ripple's strength. The first also carries the unseen splash.
/// - Each front crossing the display: a wash that brightens as it climbs and
///   flutters at the rings' own rate (speed ÷ wavelength).
/// - The text: a pad that swells with its opacity and brightens as it
///   sharpens.
public struct SoundConfig: Sendable {
  public var sampleRate: Double = 48_000
  /// Seconds rendered past the held frame so the reverb can ring out.
  public var tail: Double = 2.5
  public var volume: Double = 0.8
  /// One drop pitch per ripple (E5, B4, A4); later ripples reuse the last.
  public var dropNotes: [Double] = [659.26, 493.88, 440.0]
  /// D3 A3 E4 F♯4: open and unresolved.
  public var padNotes: [Double] = [146.83, 220.0, 329.63, 369.99]
  public var reverbMix: Double = 0.3

  public init() {}
}

public struct StereoAudio: Sendable {
  public let sampleRate: Double
  public var left: [Float]
  public var right: [Float]

  public var duration: Double { Double(left.count) / sampleRate }
}

public func renderScore(_ c: IntroConfig, sound s: SoundConfig = SoundConfig()) -> StereoAudio {
  var mix = Mix(sampleRate: s.sampleRate, duration: c.end + s.tail)
  var noise = Noise(seed: 0x5EED)
  let reference = IntroGeometry(width: IntroConfig.referenceWidth, height: 900, config: c)
  // The rings pass a point at this rate; the wash flutters with them.
  let flutter = reference.speed / reference.q / c.wavelength

  for (index, start) in c.rippleStarts.enumerated() {
    let strength = Double(c.rippleStrengths[index])
    let note = s.dropNotes[min(index, s.dropNotes.count - 1)]
    let pan = index == 0 ? 0 : (index.isMultiple(of: 2) ? 0.25 : -0.25)
    mix.add(at: start, for: 0.8, pan: pan) { t in drop(t, frequency: note, strength: strength) }
    mix.add(at: start, for: 2.0) { t in thump(t, strength: strength) }
    if index == 0 {
      var band = Bandpass(frequency: 2_400, q: 1.2, sampleRate: s.sampleRate)
      mix.add(at: start, for: 0.12) { t in
        band.process(noise.next()) * 0.5 * attackDecay(t, attack: 0.001, decay: 0.025)
      }
    }
    var lowL = OnePole(), lowR = OnePole()
    mix.addStereo(at: start, for: c.travel + 0.6) { t in
      let p = min(1, t / c.travel)
      let swell = pow(sin(.pi * p), 2) * exp(-t * c.decay) * strength * 0.16
      let shimmer = 0.7 + 0.3 * sin(2 * .pi * flutter * t)
      let cutoff = 250 + 2_200 * p
      return (
        lowL.process(noise.next(), cutoff: cutoff, sampleRate: s.sampleRate) * swell * shimmer,
        lowR.process(noise.next(), cutoff: cutoff, sampleRate: s.sampleRate) * swell * shimmer
      )
    }
  }

  let padLength = c.end + s.tail - c.textFadeStart
  for (index, note) in s.padNotes.enumerated() {
    let pan = -0.4 + 0.8 * Double(index) / Double(max(1, s.padNotes.count - 1))
    mix.add(at: c.textFadeStart, for: padLength, pan: pan) { t in
      let absolute = c.textFadeStart + t
      let text = textFrame(time: absolute, q: 1, config: c)
      let release = exp(-max(0, absolute - c.end - 0.3) / 0.9)
      let sharpness = 1 - text.blur / c.maxTextBlur
      let breathe = 1 + 0.15 * sin(2 * .pi * (0.2 + 0.05 * Double(index)) * t)
      return pad(t, frequency: note, brightness: sharpness) * text.opacity * release * breathe * 0.045
    }
  }

  return mix.finish(reverb: s.reverbMix, volume: s.volume)
}

// MARK: Voices. `t` is seconds since the voice started.

func attackDecay(_ t: Double, attack: Double, decay: Double) -> Double {
  (1 - exp(-t / attack)) * exp(-t / decay)
}

/// A droplet: a sine whose pitch springs upward as it decays.
func drop(_ t: Double, frequency: Double, strength: Double) -> Double {
  let glide = 0.025
  let phase = 2 * .pi * frequency * (t + 0.6 * (t - glide * (1 - exp(-t / glide))))
  let body = sin(phase) + 0.25 * sin(2.76 * phase)
  return body * attackDecay(t, attack: 0.002, decay: 0.09 * (0.7 + 0.3 * strength)) * 0.3 * strength
}

/// The weight of the stone: a sub that falls from 58 to 38 Hz.
func thump(_ t: Double, strength: Double) -> Double {
  let phase = 2 * .pi * (38 * t + 20 * 0.12 * (1 - exp(-t / 0.12)))
  return sin(phase) * attackDecay(t, attack: 0.006, decay: 0.35 * strength.squareRoot()) * 0.3 * strength
}

/// Detuned sines; overtones come in as the text sharpens.
func pad(_ t: Double, frequency: Double, brightness: Double) -> Double {
  var sum = 0.0
  for detune in [0.9988, 1.0012] {
    let phase = 2 * .pi * frequency * detune * t
    sum += sin(phase) + brightness * (0.25 * sin(2 * phase) + 0.1 * sin(3 * phase))
  }
  return sum
}

// MARK: Mixing

struct Mix {
  let sampleRate: Double
  var left: [Float]
  var right: [Float]

  init(sampleRate: Double, duration: Double) {
    self.sampleRate = sampleRate
    let count = Int((duration * sampleRate).rounded(.up))
    left = [Float](repeating: 0, count: count)
    right = left
  }

  /// Equal-power pan, −1 left to 1 right.
  mutating func add(at start: Double, for duration: Double, pan: Double = 0, _ voice: (Double) -> Double) {
    let gainL = (0.5 * (1 - pan)).squareRoot()
    let gainR = (0.5 * (1 + pan)).squareRoot()
    addStereo(at: start, for: duration) { t in
      let v = voice(t)
      return (v * gainL, v * gainR)
    }
  }

  mutating func addStereo(at start: Double, for duration: Double, _ voice: (Double) -> (Double, Double)) {
    let first = max(0, Int((start * sampleRate).rounded(.up)))
    let last = min(left.count, Int(((start + duration) * sampleRate).rounded(.up)))
    guard first < last else { return }
    for i in first ..< last {
      let (l, r) = voice(Double(i) / sampleRate - start)
      left[i] += Float(l)
      right[i] += Float(r)
    }
  }

  /// Adds the room, then soft-limits so nothing clips.
  func finish(reverb mixAmount: Double, volume: Double) -> StereoAudio {
    var room = Reverb(sampleRate: sampleRate)
    var outL = left
    var outR = right
    for i in left.indices {
      let (wetL, wetR) = room.process((left[i] + right[i]) * 0.5)
      outL[i] = limit(left[i] + Float(mixAmount) * wetL, volume)
      outR[i] = limit(right[i] + Float(mixAmount) * wetR, volume)
    }
    return StereoAudio(sampleRate: sampleRate, left: outL, right: outR)
  }

  private func limit(_ x: Float, _ volume: Double) -> Float {
    Float(volume) * tanh(x * 1.2) / tanh(1.2)
  }
}

/// Deterministic white noise, so every render of the score is identical.
struct Noise {
  var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> Double {
    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    return Double(state >> 11) / Double(1 << 53) * 2 - 1
  }
}

struct OnePole {
  var y = 0.0
  mutating func process(_ x: Double, cutoff: Double, sampleRate: Double) -> Double {
    y += (1 - exp(-2 * .pi * cutoff / sampleRate)) * (x - y)
    return y
  }
}

struct Bandpass {
  let b0, b2, a1, a2: Double
  var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0

  init(frequency: Double, q: Double, sampleRate: Double) {
    let w = 2 * .pi * frequency / sampleRate
    let alpha = sin(w) / (2 * q)
    let a0 = 1 + alpha
    b0 = alpha / a0
    b2 = -alpha / a0
    a1 = -2 * cos(w) / a0
    a2 = (1 - alpha) / a0
  }

  mutating func process(_ x: Double) -> Double {
    let y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    return y
  }
}

/// A small Freeverb-style room: parallel damped combs into allpasses, with
/// the right channel's delays offset for width.
struct Reverb {
  private var combsL: [Comb]
  private var combsR: [Comb]
  private var passesL: [Allpass]
  private var passesR: [Allpass]

  init(sampleRate: Double) {
    let scale = sampleRate / 44_100
    let combs = [1116, 1188, 1277, 1356, 1422, 1491]
    let passes = [556, 441, 341, 225]
    func size(_ n: Int, _ spread: Int) -> Int { Int(Double(n + spread) * scale) }
    combsL = combs.map { Comb(size($0, 0)) }
    combsR = combs.map { Comb(size($0, 23)) }
    passesL = passes.map { Allpass(size($0, 0)) }
    passesR = passes.map { Allpass(size($0, 23)) }
  }

  mutating func process(_ x: Float) -> (Float, Float) {
    var l: Float = 0
    var r: Float = 0
    for i in combsL.indices {
      l += combsL[i].process(x)
      r += combsR[i].process(x)
    }
    l /= Float(combsL.count)
    r /= Float(combsR.count)
    for i in passesL.indices {
      l = passesL[i].process(l)
      r = passesR[i].process(r)
    }
    return (l, r)
  }

  private struct Comb {
    var buffer: [Float]
    var index = 0
    var store: Float = 0
    init(_ size: Int) { buffer = [Float](repeating: 0, count: max(1, size)) }
    mutating func process(_ x: Float) -> Float {
      let y = buffer[index]
      store = y * 0.75 + store * 0.25
      buffer[index] = x + store * 0.83
      index = (index + 1) % buffer.count
      return y
    }
  }

  private struct Allpass {
    var buffer: [Float]
    var index = 0
    init(_ size: Int) { buffer = [Float](repeating: 0, count: max(1, size)) }
    mutating func process(_ x: Float) -> Float {
      let b = buffer[index]
      buffer[index] = x + b * 0.5
      index = (index + 1) % buffer.count
      return b - x
    }
  }
}

// MARK: Files

/// 16-bit stereo WAV, for listening to the score outside the overlay.
public func writeWAV(_ audio: StereoAudio, to url: URL) throws {
  let frames = audio.left.count
  var data = Data()
  func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + frames * 4))
  data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(2))
  append(UInt32(audio.sampleRate)); append(UInt32(audio.sampleRate * 4)); append(UInt16(4)); append(UInt16(16))
  data.append(contentsOf: Array("data".utf8)); append(UInt32(frames * 4))
  for i in 0 ..< frames {
    for sample in [audio.left[i], audio.right[i]] {
      append(Int16(max(-1, min(1, sample)) * Float(Int16.max)))
    }
  }
  try data.write(to: url)
}
