import CoreGraphics

/// The desktop picture's scaling, as `NSWorkspace.desktopImageOptions` reports
/// it (`NSImageScaling` raw values).
public enum WallpaperScaling: Int, Sendable {
  case proportionallyDown = 0
  case axesIndependently = 1
  case none = 2
  case proportionallyUpOrDown = 3
}

/// Where the wallpaper image lands on a screen, in the same units as `screen`.
/// Mirrors how the Dock lays out desktop pictures: "Fill Screen" is
/// up-or-down with clipping, "Fit to Screen" the same without.
public func wallpaperPlacement(
  image: CGSize, screen: CGSize, scaling: WallpaperScaling, allowClipping: Bool
) -> CGRect {
  guard image.width > 0, image.height > 0 else { return .zero }
  let fit = min(screen.width / image.width, screen.height / image.height)
  let fill = max(screen.width / image.width, screen.height / image.height)
  let scale: CGFloat
  switch scaling {
  case .axesIndependently: return CGRect(origin: .zero, size: screen)
  case .none: scale = 1
  case .proportionallyDown: scale = min(1, allowClipping ? fill : fit)
  case .proportionallyUpOrDown: scale = allowClipping ? fill : fit
  }
  let size = CGSize(width: image.width * scale, height: image.height * scale)
  return CGRect(
    x: (screen.width - size.width) / 2, y: (screen.height - size.height) / 2,
    width: size.width, height: size.height
  )
}

/// The wallpaper as it appears on a screen `width × height` device pixels.
public func composeWallpaper(
  _ image: CGImage, width: Int, height: Int, scaling: WallpaperScaling, allowClipping: Bool, fill: CGColor
) -> CGImage? {
  let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  guard let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info
  ) else { return nil }
  context.setFillColor(fill)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.interpolationQuality = .high
  let rect = wallpaperPlacement(
    image: CGSize(width: image.width, height: image.height),
    screen: CGSize(width: width, height: height), scaling: scaling, allowClipping: allowClipping
  )
  context.draw(image, in: rect)
  return context.makeImage()
}
