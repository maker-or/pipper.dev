import CoreGraphics
import Foundation

/// The window the intro ends in. Once the last frame is held, the host sends
/// `close {json}`: the dark draws in to this window's frame, takes on its
/// background, and the overlay hands over to the real window underneath.
///
/// Positions are points with the origin at the top left of the menu-bar
/// display, as Electron reports window bounds.
public struct CloseTarget: Sendable, Equatable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double
  /// The window's corner radius in points.
  public var cornerRadius: Double
  /// The window's background, sRGB 0–1; nil keeps the dark's own colour.
  public var color: SIMD3<Double>?

  public init(x: Double, y: Double, width: Double, height: Double, cornerRadius: Double, color: SIMD3<Double>?) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
    self.cornerRadius = cornerRadius
    self.color = color
  }

  /// Reads a `close {json}` command; nil for anything else or a frame with
  /// no area. `color` is `[r, g, b]`, 0–255.
  public init?(command: String) {
    let prefix = "close "
    guard command.hasPrefix(prefix),
          let object = try? JSONSerialization.jsonObject(with: Data(command.dropFirst(prefix.count).utf8)),
          let fields = object as? [String: Any],
          let x = (fields["x"] as? NSNumber)?.doubleValue,
          let y = (fields["y"] as? NSNumber)?.doubleValue,
          let width = (fields["width"] as? NSNumber)?.doubleValue,
          let height = (fields["height"] as? NSNumber)?.doubleValue,
          width > 0, height > 0
    else { return nil }
    let radius = (fields["radius"] as? NSNumber)?.doubleValue ?? 0
    var color: SIMD3<Double>?
    if let rgb = fields["color"] as? [NSNumber], rgb.count == 3 {
      color = SIMD3(rgb.map { min(1, max(0, $0.doubleValue / 255)) })
    }
    self.init(x: x, y: y, width: width, height: height, cornerRadius: max(0, radius), color: color)
  }

  /// The frame inside a full-display view of `screen` points, y up as AppKit
  /// draws, or nil when the window isn't on that display at all.
  public func frame(in screen: CGSize) -> CGRect? {
    let rect = CGRect(x: x, y: Double(screen.height) - y - height, width: width, height: height)
    let display = CGRect(origin: .zero, size: screen)
    return display.intersects(rect) ? rect : nil
  }
}
