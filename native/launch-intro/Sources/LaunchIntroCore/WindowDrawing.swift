import CoreGraphics
import Foundation

/// The printed window: version 2's ending. A laser prints the window the user
/// is about to land in from top to bottom: above its scan line the window is
/// already there in its real colours (its background, cards, toggles,
/// button, and soft bars where its text and icons go), with a thin outline
/// glowing on the rows just printed. The last frame is the window without
/// its text and icons, and the host's hand-over fades in the rest.
///
/// The host measures the real window and sends it as `layout {json}` before
/// the print starts: the window's frame, corner radius and background, and
/// every element, all in points from the top left of the menu-bar display.
/// Without one, the intro ends as it did before.
public struct DrawnShape: Sendable, Equatable {
  public enum Kind: String, Sendable {
    /// Traced around its outline.
    case shape
    /// A line of text, drawn as a soft bar from left to right.
    case text
  }

  public var kind: Kind
  /// Elements of one group (a card and what is in it) are drawn together;
  /// groups follow each other, top to bottom.
  public var group: Int
  /// Device pixels, y down.
  public var rect: CGRect
  public var radius: Double
  /// sRGB 0–1 and alpha; nil for none.
  public var fill: SIMD4<Double>?

  public init(kind: Kind, group: Int, rect: CGRect, radius: Double, fill: SIMD4<Double>?) {
    self.kind = kind
    self.group = group
    self.rect = rect
    self.radius = radius
    self.fill = fill
  }
}

public struct WindowDrawing: Sendable {
  /// The window first, then its elements in the order they are drawn.
  public let shapes: [DrawnShape]
  public let config: IntroConfig

  /// Seconds for the laser to print the window, top to bottom, in `bands`
  /// bands.
  public static let print = 4.0
  public static let bands = 8
  /// How far above the scan line the freshly printed outlines still glow,
  /// as a fraction of the window's height.
  public static let trail = 0.12
  /// Seconds the printed window is held before the host takes over.
  public static let hold = 0.5

  public init(window: DrawnShape, elements: [DrawnShape], config: IntroConfig) {
    shapes = [window] + elements
    self.config = config
  }

  /// The print starts. The layout must have arrived by then.
  public var start: Double {
    config.carousel?.handoff ?? config.phrase?.handoff ?? (config.surfaceEnd + 0.2)
  }

  /// The scan line has reached the bottom of the window.
  public var printed: Double { start + Self.print }
  /// The last frame, held until the host closes the overlay into the window.
  public var end: Double { printed + Self.hold }

  /// The window's heading, the first line of text in it.
  public var heading: Int? { shapes.indices.dropFirst().first { shapes[$0].kind == .text } }

  /// The printer printing the window: `blank` before it starts, `done`
  /// once it has finished.
  public func scan(time t: Double) -> ScanLine {
    let window = shapes[0].rect
    return scanLine(
      sweeping: window.insetBy(dx: -window.width * 0.03, dy: 0), bands: Self.bands,
      from: start, to: printed, time: t
    )
  }
}

extension WindowDrawing {
  /// Reads a `layout {json}` command into device pixels for a display whose
  /// top left is at `origin` points and has `scale` pixels per point. Nil for
  /// anything else. The host sends the window alone as soon as it exists,
  /// then again with its elements once its page has loaded.
  public init?(command: String, origin: CGPoint, scale: Double, config: IntroConfig) {
    let prefix = "layout "
    guard command.hasPrefix(prefix),
          let object = try? JSONSerialization.jsonObject(with: Data(command.dropFirst(prefix.count).utf8)),
          let fields = object as? [String: Any],
          let window = fields["window"] as? [String: Any],
          let elements = fields["elements"] as? [[String: Any]]
    else { return nil }

    func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }
    func colour(_ value: Any?) -> SIMD4<Double>? {
      guard let rgba = value as? [NSNumber], rgba.count >= 3 else { return nil }
      let alpha = rgba.count > 3 ? rgba[3].doubleValue / 255 : 1
      return SIMD4(rgba[0].doubleValue / 255, rgba[1].doubleValue / 255, rgba[2].doubleValue / 255, alpha)
    }
    func shape(_ fields: [String: Any], kind: DrawnShape.Kind, group: Int) -> DrawnShape? {
      guard let x = number(fields["x"]), let y = number(fields["y"]),
            let width = number(fields["width"]), let height = number(fields["height"]),
            width > 0, height > 0
      else { return nil }
      let rect = CGRect(
        x: (x - origin.x) * scale, y: (y - origin.y) * scale, width: width * scale, height: height * scale
      )
      let radius = min(max(0, number(fields["radius"]) ?? 0) * scale, rect.width / 2, rect.height / 2)
      return DrawnShape(kind: kind, group: group, rect: rect, radius: radius, fill: colour(fields["color"] ?? fields["fill"]))
    }

    guard let frame = shape(window, kind: .shape, group: 0) else { return nil }
    let drawn = elements.compactMap { element -> DrawnShape? in
      let kind = DrawnShape.Kind(rawValue: element["kind"] as? String ?? "") ?? .shape
      return shape(element, kind: kind, group: (element["group"] as? NSNumber)?.intValue ?? 0)
    }
    self.init(window: frame, elements: Array(drawn.prefix(Self.maxShapes - 1)), config: config)
  }

  /// The most shapes the renderer draws, window included: within one 4 KB
  /// shader argument.
  public static let maxShapes = 60
}
