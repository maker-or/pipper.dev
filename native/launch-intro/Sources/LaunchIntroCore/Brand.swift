import CoreGraphics
import Foundation

/// Version 2's name: once the ripples have crossed the display, Pipper's
/// brand icons pop in one by one, one tile per letter, each with a pop; then
/// each pops out in the same order and its letter of "Pipper" pops in where it
/// was; once all are in, the letters close up into the word. The line
/// follows (`Phrase`).
public struct Brand: Sendable, Equatable {
  public var name = "Pipper"
  /// The first tile pops in here; each next `step` later.
  public var start: Double = 3.5
  public var step: Double = 0.2
  /// Seconds for a tile or letter to spring into place.
  public var spring: Double = 0.45
  /// Seconds the full row of tiles is held before the first pops out.
  public var hold: Double = 0.45
  /// Seconds between one tile popping out and the next.
  public var outStep: Double = 0.16
  /// Seconds for a tile to swell and vanish.
  public var popOut: Double = 0.18
  /// Tile height and the gap between tiles, in design units; letters are
  /// set at `letterSize`.
  public var tileHeight: Double = 64
  public var gap: Double = 16
  public var letterSize: Double = 76
  /// How far above the middle of the display the name sits, in design
  /// units, leaving the middle for the line.
  public var lift: Double = 86
  /// Seconds for the letters to close up from their tiles into the word.
  public var close: Double = 0.5

  public init() {}

  /// Tile `i` starts to pop in.
  public func popIn(_ i: Int) -> Double { start + Double(i) * step }
  /// Tile `i` starts to pop out, and its letter in.
  public func popOutTime(_ i: Int) -> Double {
    popIn(name.count - 1) + spring + hold + Double(i) * outStep
  }
  /// The letters start to close up into the word, as the last one lands.
  public var closing: Double { popOutTime(name.count - 1) + 0.06 + spring * 0.6 }
  /// The name is whole.
  public var done: Double { closing + close }
}

/// A springy arrival: from 0 overshooting past 1 and settling, over `u` 0 to 1.
func popSpring(_ u: Double) -> Double {
  guard u > 0 else { return 0 }
  guard u < 1 else { return 1 }
  return 1 - exp(-6 * u) * cos(9 * u)
}

/// One tile and its letter at one moment.
public struct BrandFrame: Sendable, Equatable {
  /// Which brand icon the tile shows (0–3).
  public var icon: Int
  /// Tile centre, device pixels, y down.
  public var centre: SIMD2<Double>
  /// The letter's centre: on its tile, then closing up into the word.
  public var letterCentre: SIMD2<Double>
  /// Device pixels.
  public var tileSize: CGSize
  /// The tile's scale (0 hidden) and the letter's.
  public var tileScale: Double
  public var letterScale: Double
}

/// The name at `time`: one frame per tile, or none before it begins.
/// `letterWidths` are the letters' advances in device pixels, for how they
/// sit in the word.
public func brandFrames(
  time t: Double, config c: IntroConfig, geometry g: IntroGeometry, letterWidths: [Double]
) -> [BrandFrame] {
  guard let brand = c.brand, t > brand.start, letterWidths.count == brand.name.count else { return [] }
  let q = g.q
  let height = brand.tileHeight * q
  let width = height * BrandIcons.tileAspect
  let pitch = width + brand.gap * q
  let count = brand.name.count
  let first = g.width / 2 - pitch * Double(count - 1) / 2
  let y = g.height / 2 - brand.lift * q
  let close = smootherstep(brand.closing, brand.done, t)
  var wordX = g.width / 2 - letterWidths.reduce(0, +) / 2
  return (0 ..< count).map { i in
    let tileCentre = SIMD2(first + pitch * Double(i), y)
    let inWord = SIMD2(wordX + letterWidths[i] / 2, y)
    wordX += letterWidths[i]
    let out = brand.popOutTime(i)
    let tile: Double
    if t < out {
      tile = popSpring((t - brand.popIn(i)) / brand.spring)
    } else {
      // A quick swell, then gone.
      let p = min(1, (t - out) / brand.popOut)
      tile = (1 - smootherstep(0, 1, p)) * (1 + 0.25 * sin(.pi * p))
    }
    return BrandFrame(
      icon: i % BrandIcons.count,
      centre: tileCentre,
      letterCentre: tileCentre + (inWord - tileCentre) * close,
      tileSize: CGSize(width: width, height: height),
      tileScale: tile,
      letterScale: popSpring((t - out - 0.06) / brand.spring)
    )
  }
}

/// Pipper's brand icons, from `src/launch/welcome-shapes.svg`: each a
/// coloured tile with its shape in a deeper ink of the same colour.
public enum BrandIcons {
  public static let count = 4
  /// Width over height of a tile.
  public static let tileAspect = 216.0 / 204.0
  static let tile = CGSize(width: 216, height: 204)
  static let corner = 28.0

  /// Tile colour, ink colour, and the ink's outline in the tile's own
  /// 216 × 204 units.
  static let icons: [(tile: UInt32, ink: UInt32, path: CGPath)] = [
    (0x26B25A, 0x088139, svgPath("""
      M102.557 31.3178C106.101 28.7432 110.899 28.7432 114.443 31.3178L173.411 74.1604C176.954 76.7351 178.437 \
      81.2987 177.084 85.4646L154.56 154.785C153.206 158.951 149.324 161.772 144.944 161.772H72.0559C67.6756 \
      161.772 63.7936 158.951 62.44 154.785L39.9163 85.4646C38.5627 81.2987 40.0455 76.7351 43.5892 74.1604\
      L102.557 31.3178Z
      """)),
    (0xFFAA4F, 0xB1620D, {
      let path = CGMutablePath()
      for y in [27.0, 77, 127] {
        path.addRoundedRect(in: CGRect(x: 27, y: y, width: 161, height: 50), cornerWidth: 25, cornerHeight: 25)
      }
      return path
    }()),
    (0x8BB8FF, 0x5F92FE, {
      let path = CGMutablePath()
      for (x, y) in [(140.0, 70.0), (76, 70), (76, 134), (140, 134)] {
        path.addEllipse(in: CGRect(x: x - 32, y: y - 32, width: 64, height: 64))
      }
      path.addRect(CGRect(x: 78, y: 70, width: 63, height: 70))
      return path
    }()),
    (0xBC4FFF, 0xA23EEB, svgPath("""
      M89.712 36.6951C98.863 23.6928 118.14 23.6928 127.29 36.6951C131.87 43.2082 139.5 46.8826 147.45 46.4056\
      C163.32 45.4534 175.34 60.5226 170.88 75.784C168.65 83.4287 170.53 91.685 175.86 97.6033C186.5 109.418 \
      182.21 128.209 167.5 134.238C160.13 137.257 154.85 143.878 153.55 151.735C150.94 167.421 133.58 175.783 \
      119.69 168.039C112.73 164.16 104.27 164.16 97.31 168.039C83.423 175.783 66.058 167.421 63.455 151.735\
      C62.151 143.878 56.87 137.257 49.501 134.238C34.788 128.209 30.499 109.418 41.139 97.6033C46.469 91.685 \
      48.353 83.4287 46.119 75.784C41.659 60.5226 53.676 45.4534 69.548 46.4056C77.498 46.8826 85.128 43.2082 \
      89.712 36.6951Z
      """)),
  ]

  /// Draws icon `index` filling `size` (y down), premultiplied RGBA.
  static func draw(_ index: Int, in context: CGContext, size: CGSize) {
    let icon = icons[index % icons.count]
    func colour(_ rgb: UInt32) -> CGColor {
      CGColor(
        srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
        blue: CGFloat(rgb & 255) / 255, alpha: 1
      )
    }
    context.saveGState()
    // SVG units, y down, into a bitmap whose origin is bottom-left.
    context.translateBy(x: 0, y: size.height)
    context.scaleBy(x: size.width / tile.width, y: -size.height / tile.height)
    context.setFillColor(colour(icon.tile))
    context.addPath(CGPath(
      roundedRect: CGRect(origin: .zero, size: tile), cornerWidth: corner, cornerHeight: corner, transform: nil
    ))
    context.fillPath()
    context.setFillColor(colour(icon.ink))
    context.addPath(icon.path)
    context.fillPath()
    context.restoreGState()
  }

  /// The few SVG path commands the brand icons use: absolute M, L, H, C, Z.
  static func svgPath(_ data: String) -> CGPath {
    let path = CGMutablePath()
    var tokens: [String] = []
    var number = ""
    func flush() { if !number.isEmpty { tokens.append(number); number = "" } }
    for ch in data {
      if ch.isLetter, ch != "e" {
        flush()
        tokens.append(String(ch))
      } else if ch == " " || ch == "," || ch == "\n" {
        flush()
      } else if ch == "-", !number.isEmpty, number.last != "e" {
        flush()
        number.append(ch)
      } else {
        number.append(ch)
      }
    }
    flush()
    var i = 0
    var command = ""
    var current = CGPoint.zero
    func next() -> CGFloat { defer { i += 1 }; return CGFloat(Double(tokens[i]) ?? 0) }
    while i < tokens.count {
      if let first = tokens[i].first, first.isLetter {
        command = tokens[i]
        i += 1
        if command == "Z" { path.closeSubpath(); continue }
      }
      switch command {
      case "M":
        current = CGPoint(x: next(), y: next()); path.move(to: current); command = "L"
      case "L":
        current = CGPoint(x: next(), y: next()); path.addLine(to: current)
      case "H":
        current = CGPoint(x: next(), y: current.y); path.addLine(to: current)
      case "V":
        current = CGPoint(x: current.x, y: next()); path.addLine(to: current)
      case "C":
        let c1 = CGPoint(x: next(), y: next())
        let c2 = CGPoint(x: next(), y: next())
        current = CGPoint(x: next(), y: next())
        path.addCurve(to: current, control1: c1, control2: c2)
      default:
        i += 1
      }
    }
    return path
  }
}
